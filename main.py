"""
本机模型接入插件（Shim Connector）

把本机已登录的 AI 客户端（Qoder / Trae / WorkBuddy）通过 loopback shim
接入 AstrBot。插件负责：

1. 起停 shim 进程（Node.js 子进程，绑 127.0.0.1）
2. 自动注册 OpenAI 兼容 provider 到 AstrBot
3. 在 WebUI 里展示运行状态

shim 本身是 scripts/ 下的 Node 脚本，凭据从本机登录态读取，不经过本插件。
"""

from __future__ import annotations

import asyncio

import aiohttp
import json
import os
import shutil
import subprocess
import tempfile
import sys
from datetime import datetime
from pathlib import Path
from typing import ClassVar

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core import AstrBotConfig

try:
    from quart import jsonify as _quart_jsonify
    from quart import request as _quart_request
except Exception:  # noqa: BLE001
    _quart_jsonify = None
    _quart_request = None

PLUGIN_DIR = Path(__file__).parent
SHIM_DIR = PLUGIN_DIR / "shims"

# 单个 shim 日志超过这个大小就滚动
MAX_LOG_BYTES = 2 * 1024 * 1024
# /shim logs 单次最多输出多少行
MAX_LOG_TAIL_LINES = 200

# 每个 shim 的默认配置。端口与 token 可在 _conf_schema.json 里改。
#
# 2026-10-29 扩展：新增 workbuddy_intl / vision / llm_pool。
# - workbuddy_intl 用同一个 workbuddy-shim.mjs，靠 WB_REGION=global 区分
# - vision / llm_pool 是轮换层，source_id 前缀分别是 vision_rotator / llm_pool
SHIM_DEFS: dict[str, dict] = {
    "workbuddy": {
        "script": "workbuddy-shim.mjs",
        "port": 8787,
        "token": "sk-workbuddy-local",
        "label": "WorkBuddy",
        "env_prefix": "WB_SHIM",
        "source_id": "workbuddy_shim",
        "extra_env": {"WB_REGION": "cn"},
    },
    "trae": {
        "script": "trae-shim.mjs",
        "port": 8788,
        "token": "sk-trae-local",
        "label": "Trae",
        "env_prefix": "TRAE_SHIM",
        "source_id": "trae_shim",
        "extra_env": {},
    },
    "qoder": {
        "script": "qoder-shim.mjs",
        "port": 8789,
        "token": "sk-qoder-local",
        "label": "Qoder",
        "env_prefix": "QODER_SHIM",
        "source_id": "qoder_shim",
        "extra_env": {},
    },
    # 国际版 WorkBuddy：同一个脚本，WB_REGION=global
    "workbuddy_intl": {
        "script": "workbuddy-shim.mjs",
        "port": 8790,
        "token": "sk-workbuddy-intl",
        "label": "WorkBuddy-Intl",
        "env_prefix": "WB_SHIM",
        "source_id": "workbuddy_intl",
        "extra_env": {"WB_REGION": "global"},
    },
    # 视觉轮换层（5 个上游轮换，见 vision-shim.mjs）
    "vision": {
        "script": "vision-shim.mjs",
        "port": 8791,
        "token": "sk-vision-local",
        "label": "Vision",
        "env_prefix": "VISION_SHIM",
        "source_id": "vision_rotator",
        "extra_env": {},
    },
    # 通用 LLM 池（10 个上游轮换，见 llm-pool-shim.mjs）
    "llm_pool": {
        "script": "llm-pool-shim.mjs",
        "port": 8792,
        "token": "sk-llm-pool-local",
        "label": "LLM-Pool",
        "env_prefix": "LLM_POOL",
        "source_id": "llm_pool",
        "extra_env": {},
    },
}


async def port_free_async(port: int, timeout: float = 0.5) -> bool:
    """异步探测端口是否空闲（不阻塞事件循环）。

    用 asyncio.open_connection 而不是 socket.connect_ex，
    避免在事件循环里做同步 I/O。

    Args:
        port: 要检查的端口。
        timeout: 连接超时秒数。

    Returns:
        True 表示可以绑定（没人监听）。
    """
    try:
        _reader, writer = await asyncio.wait_for(
            asyncio.open_connection("127.0.0.1", port), timeout=timeout
        )
    except (asyncio.TimeoutError, OSError):
        # 连不上 = 端口空闲
        return True
    writer.close()
    try:
        await writer.wait_closed()
    except Exception:  # noqa: BLE001
        pass
    # 连上了 = 有人监听
    return False



class ShimConnector(Star):
    """把本机 shim 接成 AstrBot 的模型源。"""

    def __init__(self, context: Context, config: AstrBotConfig | None = None):
        super().__init__(context)
        self.context = context
        self.config = config or {}
        # name -> subprocess.Popen
        self.procs: dict[str, subprocess.Popen] = {}
        # 已经注册过的 provider id，避免重复
        self.registered: set[str] = set()
        self._lock = asyncio.Lock()
        # WebUI 热启停接口
        self._register_web_apis()
        # 配置热重载：盯配置文件 mtime，变了就差分启停
        self._cfg_mtime: float = 0.0
        self._cfg_watch_task: asyncio.Task | None = None
        # 记录「上次生效」的启用状态，用于差分
        self._applied: dict[str, bool] = {}

    # ── 配置读取 ────────────────────────────────────────────────

    # 各内置 shim 的默认启用状态（仅分开关默认值）
    _DEFAULT_ENABLE: ClassVar[dict[str, bool]] = {
        "workbuddy": True,
        "trae": True,
        "qoder": True,
        "workbuddy_intl": False,
        "vision": False,
        "llm_pool": False,
    }

    def _master_enabled(self) -> bool:
        """总闸状态。

        没有这个配置项时视为开启（升级兼容）。

        Returns:
            True 表示总闸开启。
        """
        section = self.config.get("shims", {}) if isinstance(self.config, dict) else {}
        if "enabled" not in section:
            return True
        return bool(section.get("enabled", True))

    def _enabled(self, name: str) -> bool:
        """该 shim 是否要启动。

        规则：**总闸 AND 分开关**。

        Args:
            name: shim 名。

        Returns:
            True 表示启动。
        """
        if not self._master_enabled():
            return False
        section = self.config.get(name, {}) if isinstance(self.config, dict) else {}
        is_custom = name in self._custom_shims() and name not in SHIM_DEFS
        default = True if is_custom else self._DEFAULT_ENABLE.get(name, False)
        return bool(section.get("enable", default))

    @staticmethod
    def _as_str_list(raw) -> list[str]:
        """把配置值归一成去空、去重的字符串列表。

        兼容三种形态：list、多行字符串、None。

        Args:
            raw: 原始配置值。

        Returns:
            清洗后的列表。
        """
        if raw is None:
            return []
        if isinstance(raw, str):
            items = raw.replace("\r", "\n").split("\n")
        elif isinstance(raw, (list, tuple)):
            items = raw
        else:
            return []
        out: list[str] = []
        for item in items:
            text = str(item).strip()
            if text == "" or text in out:
                continue
            out.append(text)
        return out

    def _custom_shims(self) -> dict[str, dict]:
        """解析「自定义 shim」配置。

        格式：名称|脚本文件|端口|token

        Returns:
            与 SHIM_DEFS 同构的字典，可直接合并使用。
        """
        section = self.config.get("shims", {}) if isinstance(self.config, dict) else {}
        raw = section.get("custom")
        out: dict[str, dict] = {}
        for line in self._as_str_list(raw):
            parts = [p.strip() for p in line.split("|")]
            if len(parts) < 3:
                logger.warning(
                    f"[shim_connector] 自定义 shim 格式不对，已跳过: {line}"
                    "（应为 名称|脚本|端口|token）"
                )
                continue
            name, script, port_s = parts[0], parts[1], parts[2]
            token = parts[3] if len(parts) > 3 and parts[3] else f"sk-{name}-local"
            if not name or not script:
                logger.warning(f"[shim_connector] 自定义 shim 缺少名称或脚本，已跳过: {line}")
                continue
            try:
                port = int(port_s)
            except ValueError:
                logger.warning(f"[shim_connector] 自定义 shim 端口不是数字，已跳过: {line}")
                continue
            if name in SHIM_DEFS:
                logger.warning(
                    f"[shim_connector] 自定义 shim 名字与内置冲突，已跳过: {name}"
                )
                continue
            out[name] = {
                "script": script,
                "port": port,
                "token": token,
                "label": name,
                "env_prefix": f"{name.upper().replace('-', '_')}_SHIM",
                "source_id": name,
                "extra_env": {},
                "custom": True,
            }
        return out

    def _all_defs(self) -> dict[str, dict]:
        """内置 + 自定义，合并后的全部 shim 定义。

        Returns:
            shim 名 -> 定义。
        """
        merged = dict(SHIM_DEFS)
        merged.update(self._custom_shims())
        return merged

    def _port(self, name: str) -> int:
        """取端口，配置优先。"""
        section = self.config.get(name, {}) if isinstance(self.config, dict) else {}
        try:
            return int(section.get("port") or self._all_defs()[name]["port"])
        except (TypeError, ValueError):
            return int(self._all_defs()[name]["port"])

    def _token(self, name: str) -> str:
        """取占位 token，配置优先。"""
        section = self.config.get(name, {}) if isinstance(self.config, dict) else {}
        return str(section.get("token") or self._all_defs()[name]["token"])

    def _models(self, name: str) -> list[str]:
        """取用户勾选的模型名单。

        留空表示「全部」，由调用方决定怎么解释。

        Args:
            name: shim 名。

        Returns:
            模型 id 列表，可能为空（表示全部）。
        """
        section = self.config.get(name, {}) if isinstance(self.config, dict) else {}
        raw = section.get("models")
        if raw is None:
            return []
        # 配置可能是 list，也可能是多行字符串（WebUI 的 list 输入框）
        if isinstance(raw, str):
            items = raw.replace("\r", "\n").split("\n")
        elif isinstance(raw, (list, tuple)):
            items = raw
        else:
            return []
        out: list[str] = []
        for item in items:
            text = str(item).strip()
            if text == "" or text in out:
                continue
            out.append(text)
        return out

    def _strict_models(self) -> bool:
        """是否严格按配置注册（False = 总是注册全部）。"""
        section = self.config.get("advanced", {}) if isinstance(self.config, dict) else {}
        return bool(section.get("strict_models", True))

    def _pick_models(self, name: str, available: list[str]) -> list[str]:
        """从 shim 返回的全部模型里，挑出用户要注册的那些。

        Args:
            name: shim 名。
            available: shim 的 /v1/models 返回的全部 id。

        Returns:
            要注册的模型 id 列表。
        """
        wanted = self._models(name)
        if not wanted:
            return list(available)
        if not self._strict_models():
            return list(available)

        picked: list[str] = []
        missing: list[str] = []
        for want in wanted:
            if want in available:
                if want not in picked:
                    picked.append(want)
            else:
                missing.append(want)
        if missing:
            logger.warning(
                f"[shim_connector] {name} 配置里的模型不存在，已忽略: {', '.join(missing)}"
                f"\n  可选: {', '.join(available)}"
            )
        if not picked:
            logger.warning(
                f"[shim_connector] {name} 配置的模型全都匹配不上，本次不注册任何模型"
            )
        return picked

    @staticmethod
    def _node_candidates() -> list[str]:
        """Node.js 的标准安装位置候选。

        只列各平台的标准路径，不含任何开发者本机特有目录。
        优先用系统环境变量推导，避免写死盘符。

        Returns:
            候选路径列表（可能不存在，由调用方用 is_file 过滤）。
        """
        out: list[str] = []
        if sys.platform == "win32":
            # 不写死盘符：优先系统环境变量，缺失时用系统盘推导
            sysdrive = os.environ.get("SystemDrive", "C:")
            pf = os.environ.get("ProgramFiles") or sysdrive + "\\Program Files"
            pf86 = os.environ.get("ProgramFiles(x86)") or sysdrive + "\\Program Files (x86)"
            local = os.environ.get("LOCALAPPDATA", "")
            out.append(str(Path(pf) / "nodejs" / "node.exe"))
            out.append(str(Path(pf86) / "nodejs" / "node.exe"))
            if local:
                out.append(str(Path(local) / "Programs" / "nodejs" / "node.exe"))
            nvm = os.environ.get("NVM_HOME")
            if nvm:
                out.append(str(Path(nvm) / "node.exe"))
        elif sys.platform == "darwin":
            out.append("/usr/local/bin/node")
            out.append("/opt/homebrew/bin/node")
        else:
            out.append("/usr/bin/node")
            out.append("/usr/local/bin/node")
        return out
    def _node_exe(self) -> str | None:
        """找 node 可执行文件。"""
        section = self.config.get("advanced", {}) if isinstance(self.config, dict) else {}
        custom = str(section.get("node_path") or "").strip()
        if custom and Path(custom).is_file():
            return custom
        found = shutil.which("node")
        if found:
            return found
        # 标准安装位置兜底（不写死盘符，用系统环境变量推导）
        for cand in self._node_candidates():
            if Path(cand).is_file():
                return cand
        return None
    # ── 生命周期 ────────────────────────────────────────────────

    async def initialize(self):
        """插件加载时：按配置起 shim 并注册 provider。"""
        node = self._node_exe()
        if node is None:
            logger.warning(
                "[shim_connector] 找不到 node，请安装 Node.js 或在配置里指定 node_path"
            )
            return

        if not self._master_enabled():
            logger.warning(
                "[shim_connector] 总开关已关闭，不启动任何 shim。\n"
                "  到插件配置 → 🔌 总开关 → 「全部开启」打开。"
            )
            return

        all_defs = self._all_defs()
        prev_alive = self._load_prev_alive()
        started = []
        reused = []
        stopped = []

        for name in all_defs:
            port = self._port(name)
            prev_port = prev_alive.get(name, 0)
            port_changed = prev_port != 0 and prev_port != port
            running = not await port_free_async(port)
            want = self._effective_enabled(name)

            # 情况 0：端口变了 → 先杀掉旧端口上的进程
            # 否则旧进程会变孤儿，新端口上又起一个，同时占两个端口。
            #
            # 注意：杀完旧进程后，**是否在新端口启动要看 want**。
            # 用户可能只是改了端口，同时把 shim 禁用了 —— 那就不该起。
            if port_changed:
                old_pid = await self._pid_listening_on_async(prev_port)
                if old_pid is not None:
                    await self._kill_pid_async(old_pid)
                    logger.info(
                        f"[shim_connector] {name} 端口 {prev_port} → {port}，"
                        f"已停止旧进程（pid={old_pid}）"
                    )
                    stopped.append(f"{name}@{prev_port}")
                else:
                    logger.info(
                        f"[shim_connector] {name} 端口 {prev_port} → {port}，"
                        f"旧端口已无进程"
                    )

                # 端口变了，旧 provider 指向的地址已失效，注销掉
                await self._unregister_providers(name)

                if not want:
                    logger.info(
                        f"[shim_connector] {name} 已禁用，新端口 {port} 不启动"
                    )
                    continue

                # 启用状态 → 在新端口启动（端口必须真空闲）
                ok = await self._start_shim(name, node, reuse_ok=False)
                if ok:
                    started.append(name)
                    logger.info(
                        f"[shim_connector] {name} 已在新端口 {port} 启动"
                    )
                continue

            # 情况 A：配置里禁用，但还在跑 → 停掉
            if not want and running:
                proc = self.procs.get(name)
                if proc is not None:
                    self._stop_shim(name, proc)
                    self.procs.pop(name, None)
                else:
                    await self._stop_by_port(name)
                stopped.append(name)
                logger.info(f"[shim_connector] {name} 已从配置禁用，停止")
                await self._unregister_providers(name)
                continue

            # 情况 B：配置里禁用，没在跑 → 什么都不做
            if not want:
                continue

            # 情况 C：配置里启用，且已经在跑 → 复用，不重启
            if running:
                reused.append(name)
                started.append(name)
                logger.info(
                    f"[shim_connector] {name} 端口 {port} 已在监听，复用（不重启）"
                )
                continue

            # 情况 D：配置里启用，但没在跑 → 启动
            ok = await self._start_shim(name, node, reuse_ok=False)
            if ok:
                started.append(name)

        if not started:
            logger.warning(
                "[shim_connector] 总开关开着，但没有任何 shim 的分开关是启用的。\n"
                "  到插件配置 → 对应 shim 分组 → 「启用」打开。"
            )
            return

        # 等 shim 起来
        await asyncio.sleep(2.0)

        for name in started:
            await self._register_provider(name)

        # 记录已生效的快照（配置语义），供后续差分
        for name in all_defs:
            self._applied[name] = self._enabled(name)

        if reused or stopped:
            logger.info(
                f"[shim_connector] 本次加载：复用 {len(reused)} 个"
                f"（{', '.join(reused) if reused else '无'}），"
                f"停止 {len(stopped)} 个"
                f"（{', '.join(stopped) if stopped else '无'}）"
            )

        # 启动配置监视（点保存后自动生效，不用重启）
        conf = self._conf_file_path()
        try:
            self._cfg_mtime = conf.stat().st_mtime if conf.is_file() else 0.0
        except Exception:  # noqa: BLE001
            self._cfg_mtime = 0.0
        if self._cfg_watch_task is None or self._cfg_watch_task.done():
            self._cfg_watch_task = asyncio.create_task(self._watch_config_loop())
            logger.info(
                f"[shim_connector] 配置热重载已启用（监视 {conf.name}，间隔 2s）"
            )

    async def terminate(self):
        """插件重载/卸载时调用。

        **不杀 shim 进程。** 原因：
        AstrBot 面板保存配置后会调 plugin_manager.reload()，
        它会走到这里。如果在这里杀掉全部 shim，用户改一个开关
        就会导致所有 shim 重启 —— 这正是不想要的。

        所以这里只做两件事：
          1. 停掉配置监视任务
          2. 把当前进程表写到磁盘，供下次 initialize 复用

        真正的停止在 initialize 里按新配置决定：
          - 配置里禁用的 → 停掉
          - 配置里启用的且端口在监听 → 复用（不重启）
          - 配置里启用的但没在跑 → 启动
        """
        task = getattr(self, "_cfg_watch_task", None)
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._cfg_watch_task = None

        # 记录仍在运行的 shim：名字 -> 当时的端口
        # 为什么要记端口：用户可能改了端口再保存，
        # initialize 必须知道「旧端口上那个进程要杀掉」。
        alive: dict[str, int] = {}
        # 先看 procs（本次进程树里起过的）
        for name, proc in self.procs.items():
            if proc is not None and proc.poll() is None:
                try:
                    alive[name] = self._port(name)
                except Exception:  # noqa: BLE001
                    pass
        # procs 可能是空的（重载时），退回用端口探测
        if not alive:
            for name in self._all_defs():
                try:
                    port = self._port(name)
                except Exception:  # noqa: BLE001
                    continue
                if await self._pid_listening_on_async(port) is not None:
                    alive[name] = port
        try:
            self._state_file().write_text(
                json.dumps({"alive": alive}, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[shim_connector] 写状态文件失败: {exc}")
        pretty = ", ".join(f"{k}@{v}" for k, v in alive.items()) or "无"
        logger.info(
            f"[shim_connector] terminate：记录 {len(alive)} 个运行中的 shim"
            f"（{pretty}），交给下次 initialize 处理"
        )
        self.procs.clear()
        self.registered.clear()
        self._applied.clear()

    @staticmethod
    def _pid_listening_on(port: int) -> int | None:
        """找出正在监听某端口的进程 PID（跨平台，用标准库）。

        Args:
            port: 端口号。

        Returns:
            PID；找不到返回 None。
        """
        import re as _re

        try:
            if sys.platform == "win32":
                out = subprocess.run(
                    ["netstat", "-ano"],
                    capture_output=True,
                    text=True,
                    timeout=8,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                ).stdout
                for line in out.splitlines():
                    if f":{port} " not in line and not line.rstrip().endswith(str(port)):
                        continue
                    if "LISTENING" not in line.upper():
                        continue
                    parts = line.split()
                    if parts and parts[-1].isdigit():
                        return int(parts[-1])
            else:
                out = subprocess.run(
                    ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                    capture_output=True,
                    text=True,
                    timeout=8,
                ).stdout.strip()
                if out:
                    return int(out.splitlines()[0])
        except Exception:  # noqa: BLE001
            pass
        return None

    def _kill_pid(self, pid: int) -> bool:
        """按 PID 杀掉进程。

        Args:
            pid: 进程 ID。

        Returns:
            True 表示成功发出终止信号。
        """
        try:
            cmd = ["taskkill", "/PID", str(pid), "/F"] if sys.platform == "win32" else ["kill", "-9", str(pid)]
            child = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0,
            )
            child.wait(timeout=8)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[shim_connector] 杀进程 pid={pid} 失败: {exc}")
            return False

    @staticmethod
    async def _pid_listening_on_async(port: int) -> int | None:
        """找出正在监听某端口的进程 PID（异步，不阻塞事件循环）。

        用 asyncio.create_subprocess_exec 跑 netstat / lsof，
        避免在 async 路径里同步阻塞。

        Args:
            port: 端口号。

        Returns:
            PID；找不到返回 None。
        """
        try:
            if sys.platform == "win32":
                proc = await asyncio.create_subprocess_exec(
                    "netstat",
                    "-ano",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                try:
                    out_b, _ = await asyncio.wait_for(proc.communicate(), timeout=8)
                except asyncio.TimeoutError:
                    proc.kill()
                    return None
                out = (out_b or b"").decode("utf-8", "ignore")
                for line in out.splitlines():
                    if f":{port} " not in line and not line.rstrip().endswith(str(port)):
                        continue
                    if "LISTENING" not in line.upper():
                        continue
                    parts = line.split()
                    if parts and parts[-1].isdigit():
                        return int(parts[-1])
            else:
                proc = await asyncio.create_subprocess_exec(
                    "lsof",
                    "-nP",
                    f"-iTCP:{port}",
                    "-sTCP:LISTEN",
                    "-t",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                try:
                    out_b, _ = await asyncio.wait_for(proc.communicate(), timeout=8)
                except asyncio.TimeoutError:
                    proc.kill()
                    return None
                out = (out_b or b"").decode("utf-8", "ignore").strip()
                if out:
                    return int(out.splitlines()[0])
        except Exception:  # noqa: BLE001
            pass
        return None

    @staticmethod
    async def _kill_pid_async(pid: int) -> bool:
        """按 PID 杀进程（异步，不阻塞事件循环）。

        Args:
            pid: 进程 ID。

        Returns:
            True 表示成功发出终止信号。
        """
        try:
            if sys.platform == "win32":
                proc = await asyncio.create_subprocess_exec(
                    "taskkill",
                    "/PID",
                    str(pid),
                    "/F",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            else:
                proc = await asyncio.create_subprocess_exec(
                    "kill",
                    "-9",
                    str(pid),
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
            try:
                await asyncio.wait_for(proc.wait(), timeout=8)
            except asyncio.TimeoutError:
                proc.kill()
                return False
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[shim_connector] 杀进程 pid={pid} 失败: {exc}")
            return False

    async def _stop_by_port(self, name: str) -> bool:
        """按端口找到监听进程并停掉（用于重载后丢失句柄的情况）。

        Args:
            name: shim 名。

        Returns:
            True 表示确实停掉了一个进程。
        """
        port = self._port(name)
        pid = await self._pid_listening_on_async(port)
        if pid is None:
            return False
        if await self._kill_pid_async(pid):
            logger.info(f"[shim_connector] 已按端口停止 {name}（:{port} pid={pid}）")
            return True
        return False

    def _state_file(self) -> Path:
        """记录运行中 shim 的状态文件（重载时复用）。"""
        return self._log_dir() / ".running.json"

    def _load_prev_alive(self) -> dict[str, int]:
        """读上次 terminate 记录的「shim 名 -> 当时端口」。

        兼容旧格式（alive 是字符串列表，没有端口信息）。

        Returns:
            {名字: 端口}；端口为 0 表示未知。
        """
        try:
            path = self._state_file()
            if not path.is_file():
                return {}
            data = json.loads(path.read_text(encoding="utf-8"))
            alive = data.get("alive")
            if isinstance(alive, dict):
                out: dict[str, int] = {}
                for k, v in alive.items():
                    try:
                        out[str(k)] = int(v)
                    except (TypeError, ValueError):
                        out[str(k)] = 0
                return out
            if isinstance(alive, list):
                # 旧格式：只有名字，端口未知
                return {str(x): 0 for x in alive if isinstance(x, str)}
            return {}
        except Exception:  # noqa: BLE001
            return {}

    def _stop_shim(self, name: str, proc: subprocess.Popen) -> None:
        """停一个 shim 进程（只影响这一个）。"""
        if proc.poll() is not None:
            return
        try:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
            logger.info(f"[shim_connector] 已停止 {name}")
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[shim_connector] 停止 {name} 失败: {exc}")

    def _disabled_names(self) -> set[str]:
        """记录被 WebUI 临时停用的 shim（重启后失效）。"""
        if not hasattr(self, "_temp_disabled"):
            self._temp_disabled: set[str] = set()
        return self._temp_disabled

    def _effective_enabled(self, name: str) -> bool:
        """实际是否应启动 = 配置启用 AND 没被临时停用。

        Args:
            name: shim 名。

        Returns:
            True 表示应启动。
        """
        if name in self._disabled_names():
            return False
        return self._enabled(name)

    async def _start_shim(
        self, name: str, node: str, *, reuse_ok: bool = True
    ) -> bool:
        """起一个 shim 子进程。

        Args:
            name: shim 名。
            node: node 可执行文件路径。
            reuse_ok: 端口被占时的处理。
                True（默认）—— 视为「我们的 shim 已在运行」，返回 True。
                    适用于插件重载、复用场景。
                False —— 视为「端口冲突」，返回 False 并报错。
                    适用于换端口、首次启动等必须真起的场景。

        Returns:
            True 表示已启动或（reuse_ok 时）已在运行。
        """
        spec = self._all_defs()[name]
        script = Path(spec["script"]) if Path(spec["script"]).is_absolute() else SHIM_DIR / spec["script"]
        if not script.is_file():
            logger.error(f"[shim_connector] 缺少脚本 {script}")
            return False

        port = self._port(name)
        if not await port_free_async(port):
            if reuse_ok:
                logger.info(
                    f"[shim_connector] {name} 端口 {port} 已被占用，视为已在运行"
                )
                return True
            # 换端口/首次启动场景：端口被占说明冲突，不能假装成功
            pid = await self._pid_listening_on_async(port)
            logger.error(
                f"[shim_connector] {name} 目标端口 {port} 已被占用"
                f"（pid={pid}），无法启动。"
                f"请改端口，或先停掉占用该端口的程序。"
            )
            return False

        env = os.environ.copy()
        env[f"{spec['env_prefix']}_PORT"] = str(port)
        env[f"{spec['env_prefix']}_TOKEN"] = self._token(name)
        # 该 shim 需要的额外环境变量（如 WB_REGION）
        for ek, ev in (spec.get("extra_env") or {}).items():
            env[ek] = str(ev)
        env.setdefault("PYTHONIOENCODING", "utf-8")
        env.setdefault("PYTHONUTF8", "1")
        # vision / llm-pool 需要读 AstrBot 配置来发现上游 provider
        try:
            env.setdefault("ASTRBOT_CONFIG", str(self._astrbot_config_path()))
        except Exception:  # noqa: BLE001
            pass

        log_path = self._log_path(name)
        try:
            self._rotate_log(log_path)
            with open(log_path, "ab") as fh:
                stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                fh.write(
                    f"\n===== {stamp} 启动 {name} (:{port}) =====\n".encode("utf-8")
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[shim_connector] 无法写日志头 {log_path}: {exc}")

        try:
            creation = 0
            if sys.platform == "win32":
                creation = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            # 输出写文件而不是 DEVNULL，这样出问题能回溯
            log_file = open(log_path, "ab", buffering=0)  # noqa: SIM115
            try:
                proc = subprocess.Popen(
                    [node, str(script)],
                    cwd=str(script.parent),
                    env=env,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    creationflags=creation,
                )
            finally:
                log_file.close()  # 父进程关句柄，子进程仍持有
            self.procs[name] = proc
            logger.info(
                f"[shim_connector] 已启动 {name} (:{port}) pid={proc.pid} "
                f"log={log_path.name}"
            )
            # 2.5 秒后检查是否秒退，把原因写进插件日志
            asyncio.create_task(self._check_started(name, proc, log_path))
            return True
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[shim_connector] 启动 {name} 失败: {exc}")
            return False

    def _astrbot_config_path(self) -> Path:
        """推断 AstrBot 数据目录下的 cmd_config.json 路径。"""
        try:
            conf = self.context.astrbot_config_mgr.default_conf
            p = getattr(conf, "config_path", None)
            if p:
                return Path(p)
        except Exception:  # noqa: BLE001
            pass
        # 兜底：插件在 <AstrBot>/data/plugins/<name>，往上两级是 data/
        return PLUGIN_DIR.parent.parent / "cmd_config.json"

    def _conf_file_path(self) -> Path:
        """本插件的配置文件路径。

        实际结构：
          <data>/cmd_config.json                      ← 主配置
          <data>/config/<插件名>_config.json          ← 插件配置

        所以插件配置目录是「主配置所在目录 / config」，
        不是主配置同目录。要兼容两种布局。

        Returns:
            配置文件路径（可能不存在）。
        """
        base = self._astrbot_config_path().parent
        name = f"{PLUGIN_DIR.name}_config.json"
        candidates = [
            base / "config" / name,   # 标准：data/config/xxx_config.json
            base / name,               # 兜底：万一某版本放同目录
        ]
        for cand in candidates:
            if cand.is_file():
                return cand
        # 都不存在时返回标准位置（供首次创建时判断）
        return candidates[0]

    def _reload_config_from_disk(self) -> dict | None:
        """从磁盘读插件配置文件。

        不改 self.config（那是 AstrBot 持有的对象），只返回一份新数据
        供差分使用。

        Returns:
            解析后的配置字典；读不到返回 None。
        """
        try:
            path = self._conf_file_path()
            if not path.is_file():
                return None
            text = path.read_text(encoding="utf-8-sig")
            data = json.loads(text)
            return data if isinstance(data, dict) else None
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[shim_connector] 读取配置失败: {exc}")
            return None

    async def _reconcile(self, reason: str = "配置变更") -> None:
        """按最新配置做差分启停，只动变化的那些 shim。

        Args:
            reason: 触发原因，仅用于日志。
        """
        fresh = self._reload_config_from_disk()
        if fresh is None:
            return

        # 用磁盘配置替换 self.config 的内容（就地更新，保持对象引用）
        try:
            if isinstance(self.config, dict):
                self.config.clear()
                self.config.update(fresh)
            else:
                self.config = fresh
        except Exception:  # noqa: BLE001
            self.config = fresh

        if not self._master_enabled():
            logger.info(f"[shim_connector] {reason}：总闸已关，停止全部 shim")
            for name in list(self.procs):
                proc = self.procs.get(name)
                if proc:
                    self._stop_shim(name, proc)
                    self.procs.pop(name, None)
                    await self._unregister_providers(name)
            self._applied.clear()
            return

        all_defs = self._all_defs()

        # 首次 reconcile 且没有基线：先记下当前状态，不执行任何动作
        # 避免把「配置里本来就关闭」误判成「需要停止」
        if not self._applied:
            for name in all_defs:
                self._applied[name] = self._enabled(name)
            logger.info(
                f"[shim_connector] {reason}：已建立基线"
                f"（{sum(1 for v in self._applied.values() if v)} 个启用）"
            )
            return

        changed = []

        for name in all_defs:
            want = self._enabled(name)
            had = self._applied.get(name, want)
            if want == had:
                continue
            changed.append(name)
            if want:
                node = self._node_exe()
                if node is None:
                    logger.warning("[shim_connector] 找不到 node，无法启动 " + name)
                    continue
                self._disabled_names().discard(name)
                ok = await self._start_shim(name, node)
                if ok:
                    await asyncio.sleep(1.0)
                    if self._auto_register():
                        await self._register_provider(name)
                    logger.info(f"[shim_connector] {reason}：已启动 {name}")
            else:
                proc = self.procs.get(name)
                if proc is not None:
                    self._stop_shim(name, proc)
                    self.procs.pop(name, None)
                removed = await self._unregister_providers(name)
                logger.info(
                    f"[shim_connector] {reason}：已停止 {name}"
                    + (f"，注销 {removed} 个 provider" if removed else "")
                )
            self._applied[name] = want

        if not changed:
            logger.info(f"[shim_connector] {reason}：没有 shim 需要变更")
        # 记录当前快照
        for name in all_defs:
            self._applied[name] = self._enabled(name)

    async def _watch_config_loop(self) -> None:
        """每 2 秒检查配置文件 mtime，变了就 reconcile。"""
        while True:
            try:
                await asyncio.sleep(2.0)
                path = self._conf_file_path()
                if not path.is_file():
                    continue
                mtime = path.stat().st_mtime
                if self._cfg_mtime == 0.0:
                    self._cfg_mtime = mtime
                    continue
                if mtime != self._cfg_mtime:
                    self._cfg_mtime = mtime
                    logger.info(
                        "[shim_connector] 检测到配置变更，准备差分启停"
                    )
                    async with self._lock:
                        await self._reconcile("配置热重载")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[shim_connector] 配置监视异常: {exc}")

    def _log_dir(self) -> Path:
        """日志目录。

        规范位置是 <AstrBot>/data/plugin_data/<插件名>/，
        这是 AstrBot 官方约定的插件持久化目录。

        如果该位置不可写（极少见），退回系统临时目录下的同名子目录，
        **不再写进插件安装目录** —— 插件目录应保持只读语义，
        写进去会污染插件、也会被插件更新覆盖。
        """
        base = PLUGIN_DIR.parent.parent / "plugin_data" / PLUGIN_DIR.name
        try:
            base.mkdir(parents=True, exist_ok=True)
            return base
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                f"[shim_connector] plugin_data 目录不可写（{exc}），"
                f"改用系统临时目录"
            )
            fb = Path(tempfile.gettempdir()) / PLUGIN_DIR.name
            fb.mkdir(parents=True, exist_ok=True)
            return fb

    def _log_path(self, name: str) -> Path:
        """某个 shim 的日志文件路径。"""
        return self._log_dir() / f"{name}.log"

    def _rotate_log(self, log_path: Path) -> None:
        """超过阈值就改名成 .1（覆盖旧备份）。"""
        try:
            if log_path.exists() and log_path.stat().st_size > MAX_LOG_BYTES:
                backup = log_path.with_suffix(".log.1")
                if backup.exists():
                    backup.unlink()
                log_path.rename(backup)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[shim_connector] 日志滚动失败 {log_path}: {exc}")

    async def _check_started(
        self, name: str, proc: subprocess.Popen, log_path: Path
    ) -> None:
        """启动后 2.5 秒检查是否秒退，把日志尾部打进插件日志。"""
        await asyncio.sleep(2.5)
        if proc.poll() is None:
            return
        tail = self._tail(log_path, 15)
        logger.error(
            f"[shim_connector] {name} 启动后立即退出 (code={proc.returncode})\n{tail}"
        )

    @staticmethod
    def _tail(path: Path, lines: int) -> str:
        """读文件尾部若干行。"""
        try:
            if not path.exists():
                return "(无日志)"
            with open(path, "rb") as fh:
                fh.seek(0, os.SEEK_END)
                size = fh.tell()
                block = min(size, 64 * 1024)
                fh.seek(size - block)
                raw = fh.read()
            text = raw.decode("utf-8", errors="replace")
            return "\n".join(text.splitlines()[-lines:])
        except Exception as exc:  # noqa: BLE001
            return f"(读取失败: {exc})"

    # ── Provider 注册 ───────────────────────────────────────────

    async def _ensure_provider_source(self, name: str) -> str | None:
        """确保该 shim 的 provider_source 存在，返回 source_id。

        采用 AstrBot 原生结构：provider_sources 里放一个共享凭据/地址的 source，
        provider 里每个模型挂一个条目并带 provider_source_id，
        这样最终 provider id 就是 "<source_id>/<model>"，
        和主链里 workbuddy_shim/space-bunny 这种写法完全一致。

        Returns:
            source_id，失败返回 None。
        """
        spec = self._all_defs()[name]
        source_id = spec["source_id"]
        port = self._port(name)
        token = self._token(name)

        source_cfg = {
            "id": source_id,
            "type": "openai_chat_completion",
            "provider_type": "chat_completion",
            "provider": "openai",
            "enable": True,
            "key": [token],
            "api_base": f"http://127.0.0.1:{port}/v1",
            "timeout": 240,
            "proxy": "",
            "custom_headers": {},
        }

        try:
            pm = self.context.provider_manager
            sources = pm.provider_sources_config or []
            existing = None
            for src in sources:
                if src.get("id") == source_id:
                    existing = src
                    break

            if existing is not None:
                # 地址或 token 变了就更新，否则不动（避免每次启动都写盘）
                changed = (
                    existing.get("api_base") != source_cfg["api_base"]
                    or existing.get("key") != source_cfg["key"]
                )
                if not changed:
                    logger.info(
                        f"[shim_connector] provider_source {source_id} 已存在且一致"
                    )
                    return source_id
                existing.update(source_cfg)
                logger.info(f"[shim_connector] provider_source {source_id} 已更新")
            else:
                sources.append(source_cfg)
                logger.info(f"[shim_connector] provider_source {source_id} 已新建")

            pm.provider_sources_config = sources

            # 持久化到当前生效的配置档案（多档案时只改当前那个）
            saved = False
            try:
                conf = self.context.astrbot_config_mgr.default_conf
                if conf is not None:
                    conf.setdefault("provider_sources", [])
                    lst = conf["provider_sources"]
                    lst[:] = [s for s in lst if s.get("id") != source_id]
                    lst.append(source_cfg)
                    conf.save_config()
                    saved = True
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    f"[shim_connector] provider_source {source_id} 持久化失败（内存已生效）: {exc}"
                )

            if not saved:
                logger.warning(
                    f"[shim_connector] provider_source {source_id} 仅内存生效，重启后需重新注册"
                )
            return source_id
        except Exception as exc:  # noqa: BLE001
            logger.error(
                f"[shim_connector] 创建 provider_source {source_id} 失败: {exc}"
            )
            return None

    async def _register_provider(self, name: str) -> None:
        """把该 shim 注册成 AstrBot 的模型 provider。

        provider id 格式：<source_id>/<model>，例如 trae_shim/glm-5.3-flash。
        """
        port = self._port(name)
        token = self._token(name)
        spec = self._all_defs()[name]
        source_id = spec["source_id"]

        available = await self._fetch_models(port, token)
        if not available:
            logger.warning(f"[shim_connector] {name} 未返回模型列表，跳过注册")
            return

        # 按用户配置筛选（留空 = 全部）
        models = self._pick_models(name, available)
        if not models:
            return
        picked_note = (
            f"（从 {len(available)} 个中选了 {len(models)} 个）"
            if len(models) != len(available)
            else f"（全部 {len(models)} 个）"
        )
        logger.info(f"[shim_connector] {name} 待注册模型 {picked_note}")

        # 先确保 source 在
        created_source = await self._ensure_provider_source(name)
        if created_source is None:
            logger.warning(
                f"[shim_connector] {name} 的 provider_source 创建失败，跳过 provider 注册"
            )
            return

        pm = self.context.provider_manager
        for model_id in models:
            pid = f"{source_id}/{model_id}"
            if pid in self.registered:
                continue

            # 已存在同名 provider 就跳过（不覆盖用户手动改过的配置）
            #
            # 注意：create_provider() 检查的是 self.acm.default_conf["provider"]，
            # 而 get_provider_by_id() 查的是 inst_map（运行时实例表），两者可能不同步
            # （例如 provider 被禁用不加载实例，但配置里还在）。
            # 所以必须两边都查，否则会撞 "Provider ID ... already exists"。
            already = False
            try:
                conf = self.context.astrbot_config_mgr.default_conf
                if conf is not None:
                    for item in conf.get("provider", []):
                        if item.get("id") == pid:
                            already = True
                            break
            except Exception:  # noqa: BLE001
                pass
            if not already:
                try:
                    if await pm.get_provider_by_id(pid) is not None:
                        already = True
                except Exception:  # noqa: BLE001
                    pass
            if already:
                self.registered.add(pid)
                logger.info(f"[shim_connector] provider {pid} 已存在，跳过")
                continue

            cfg = {
                "id": pid,
                "provider_source_id": source_id,
                "model": model_id,
                "enable": True,
                "modalities": ["text", "tool_use"],
                "custom_extra_body": {},
                "max_context_tokens": 0,
            }
            try:
                await pm.create_provider(cfg)
                self.registered.add(pid)
                logger.info(
                    f"[shim_connector] 已注册 {pid} -> {model_id} (:{port})"
                )
            except Exception as exc:  # noqa: BLE001
                logger.error(f"[shim_connector] 注册 {pid} 失败: {exc}")

    async def _fetch_models(self, port: int, token: str) -> list[str]:
        """从 shim 的 /v1/models 拿模型 id。

        Args:
            port: shim 端口。
            token: 该 shim 的 Bearer token。

        Returns:
            模型 id 列表，失败时为空。
        """
        url = f"http://127.0.0.1:{port}/v1/models"
        timeout = aiohttp.ClientTimeout(total=30)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(
                    url, headers={"Authorization": f"Bearer {token}"}
                ) as resp:
                    if resp.status != 200:
                        logger.warning(
                            f"[shim_connector] :{port}/v1/models 返回 HTTP {resp.status}"
                        )
                        return []
                    doc = await resp.json()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[shim_connector] 读取 :{port}/v1/models 失败: {exc}")
            return []

        data = doc.get("data") or []
        return [item["id"] for item in data if isinstance(item, dict) and item.get("id")]
    # ── 命令 ────────────────────────────────────────────────────

    @filter.command("shim")
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def shim_cmd(self, event: AstrMessageEvent):
        """查看本机 shim 状态。用法：/shim [status|start|stop|restart]"""
        args = event.message_str.strip().split()
        action = args[1] if len(args) > 1 else "status"

        if action == "status":
            yield event.plain_result(await self._status_text())
            return

        if action == "start":
            node = self._node_exe()
            if node is None:
                yield event.plain_result("找不到 node，请先安装 Node.js 或在插件配置里指定 node_path。")
                return
            results = []
            for name in self._all_defs():
                if not self._enabled(name):
                    continue
                ok = await self._start_shim(name, node)
                all_names = self._all_defs()
                results.append(
                    f"{all_names[name]['label']}: {'已启动' if ok else '失败'}"
                )
            await asyncio.sleep(2.0)
            for name in self._all_defs():
                if self._enabled(name):
                    await self._register_provider(name)
            yield event.plain_result("\n".join(results) + "\n\n" + await self._status_text())
            return

        if action == "stop":
            for name, proc in list(self.procs.items()):
                self._stop_shim(name, proc)
            self.procs.clear()
            yield event.plain_result("已停止所有由插件启动的 shim。\n\n" + await self._status_text())
            return

        if action == "restart":
            for name, proc in list(self.procs.items()):
                self._stop_shim(name, proc)
            self.procs.clear()
            await asyncio.sleep(1.0)
            node = self._node_exe()
            if node is None:
                yield event.plain_result("找不到 node。")
                return
            for name in self._all_defs():
                if self._enabled(name):
                    await self._start_shim(name, node)
            await asyncio.sleep(2.0)
            for name in self._all_defs():
                if self._enabled(name):
                    await self._register_provider(name)
            yield event.plain_result("已重启。\n\n" + await self._status_text())
            return

        if action == "logs":
            # /shim logs            所有 shim 各最后 20 行
            # /shim logs trae       只看 trae
            # /shim logs trae 50    只看 trae 最后 50 行
            target = args[2].lower() if len(args) > 2 else ""
            try:
                want = int(args[3]) if len(args) > 3 else 20
            except ValueError:
                want = 20
            want = max(1, min(want, MAX_LOG_TAIL_LINES))

            names = [target] if target else list(self._all_defs().keys())
            chunks = []
            for nm in names:
                if nm not in self._all_defs():
                    chunks.append(
                        f"未知 shim: {nm}\n可选: {', '.join(self._all_defs())}"
                    )
                    continue
                lp = self._log_path(nm)
                body = self._tail(lp, want)
                chunks.append(
                    f"===== {self._all_defs()[nm]['label']} ({nm}) =====\n{body}\n"
                    f"[文件] {lp}"
                )
            yield event.plain_result("\n\n".join(chunks))
            return

        yield event.plain_result(
            "未知操作 {0}。用法：/shim [status|start|stop|restart|logs]".format(action)
        )

    async def _status_text(self) -> str:
        """生成状态文本（异步探测端口，不阻塞事件循环）。"""
        lines = ["本机 shim 状态", ""]
        for name, spec in self._all_defs().items():
            port = self._port(name)
            enabled = self._enabled(name)
            running = not await port_free_async(port)
            proc = self.procs.get(name)
            pid = proc.pid if proc and proc.poll() is None else "-"
            mark = "[运行]" if running else "[停止]"
            state = "" if enabled else " (未启用)"
            lines.append(
                f"{mark} {spec['label']:<14} :{port:<6} pid={pid:<7} "
                f"src={spec['source_id']}{state}"
            )
        lines.append("")
        lines.append(f"日志目录: {self._log_dir()}")
        lines.append("用法: /shim [status|start|stop|restart|logs [名称] [行数]]")
        return "\n".join(lines)

    # ── WebUI 热启停接口 ────────────────────────────────────────

    def _register_web_apis(self) -> None:
        """注册 WebUI 用的热启停接口（无需重启 AstrBot）。"""
        routes = (
            ("status", self._api_status, ["GET"], "shim 运行状态"),
            ("start", self._api_start, ["POST"], "启动指定 shim"),
            ("stop", self._api_stop, ["POST"], "停止指定 shim"),
            ("restart", self._api_restart, ["POST"], "重启指定 shim"),
            ("toggle", self._api_toggle, ["POST"], "切换指定 shim 启停"),
        )
        for endpoint, handler, methods, desc in routes:
            try:
                self.context.register_web_api(
                    f"/astrbot_plugin_shim_connector/{endpoint}",
                    handler,
                    methods,
                    desc,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[shim_connector] 注册 Web API {endpoint} 失败: {exc}")

    async def _api_response(self, payload: dict, status: int = 200):
        """构造 Web API 响应。"""
        if _quart_jsonify is None:
            return payload
        response = _quart_jsonify(payload)
        response.status_code = status
        return response

    async def _api_body(self) -> dict:
        """读 POST body。"""
        if _quart_request is None:
            return {}
        try:
            data = await _quart_request.get_json(silent=True)
            return data if isinstance(data, dict) else {}
        except Exception:  # noqa: BLE001
            return {}

    async def _api_status(self):
        """GET 状态：每个 shim 的启用/运行/source 信息。"""

        async def handler():
            items = []
            for name, spec in self._all_defs().items():
                port = self._port(name)
                items.append(
                    {
                        "name": name,
                        "label": spec["label"],
                        "port": port,
                        "enabled": self._enabled(name),
                        "running": not await port_free_async(port),
                        "source_id": spec["source_id"],
                        "custom": bool(spec.get("custom")),
                    }
                )
            return {
                "ok": True,
                "master": self._master_enabled(),
                "log_dir": str(self._log_dir()),
                "shims": items,
            }

        return await self._api_response(await handler())

    def _auto_register(self) -> bool:
        """是否自动注册 provider。"""
        section = self.config.get("advanced", {}) if isinstance(self.config, dict) else {}
        return bool(section.get("auto_register", True))

    async def _unregister_providers(self, name: str) -> int:
        """注销某个 shim 注册的全部 provider 与 provider_source。

        Args:
            name: shim 名。

        Returns:
            实际移除的 provider 数量。
        """
        spec = self._all_defs().get(name)
        if not spec:
            return 0
        source_id = spec["source_id"]
        pm = self.context.provider_manager
        removed = 0
        try:
            conf = self.context.astrbot_config_mgr.default_conf
            if conf is None:
                return 0
            # 1) 移除 provider 里 provider_source_id == source_id 的条目
            providers = conf.get("provider", [])
            keep = [
                item
                for item in providers
                if item.get("provider_source_id") != source_id
            ]
            removed = len(providers) - len(keep)
            if removed:
                conf["provider"] = keep
            # 2) 移除 provider_source
            sources = conf.get("provider_sources", [])
            left = [s for s in sources if s.get("id") != source_id]
            if len(left) != len(sources):
                conf["provider_sources"] = left
            # 3) 清掉内存里的实例
            for pid in list(self.registered):
                if pid.startswith(source_id + "/") or pid == source_id:
                    try:
                        await pm.terminate_provider(pid)
                    except Exception:  # noqa: BLE001
                        pass
                    self.registered.discard(pid)
            conf.save_config()
            logger.info(
                f"[shim_connector] 已注销 {name} 的 {removed} 个 provider"
                f"（source={source_id}）"
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[shim_connector] 注销 {name} 的 provider 失败: {exc}")
        return removed

    def _require_name(self, name: str) -> str:
        """校验 shim 名。"""
        defs = self._all_defs()
        if name not in defs:
            raise ValueError(
                f"未知 shim: {name}。可选: {', '.join(defs)}"
            )
        return name

    async def _do_start(self, name: str) -> str:
        """启动单个 shim（不写配置，不影响其他 shim）。"""
        self._require_name(name)
        node = self._node_exe()
        if node is None:
            raise RuntimeError("找不到 node，请在配置里指定 advanced.node_path")
        # 手动启动 = 解除临时停用
        self._disabled_names().discard(name)
        ok = await self._start_shim(name, node)
        if not ok:
            raise RuntimeError(f"{name} 启动失败，看日志")
        await asyncio.sleep(1.5)
        if self._auto_register():
            await self._register_provider(name)
        return f"{name} 已启动（:{self._port(name)}）"

    async def _do_stop(self, name: str) -> str:
        """停止单个 shim（不写配置，不影响其他 shim）。"""
        self._require_name(name)
        self._disabled_names().add(name)

        proc = self.procs.get(name)
        if proc is None or proc.poll() is not None:
            self.procs.pop(name, None)
            # 不是插件启动的（例如你手动跑的），只标记停用，不动进程
            raise RuntimeError(
                f"{name} 不是由插件启动的，无法停止。"
                f"已标记为停用，下次插件重启不会再拉起它。"
            )
        self._stop_shim(name, proc)
        self.procs.pop(name, None)

        # 注销该 shim 的 provider（取消接口监视）
        removed = await self._unregister_providers(name)
        suffix = f"，已注销 {removed} 个 provider" if removed else ""
        return f"{name} 已停止（:{self._port(name)}）{suffix}"

    async def _api_start(self):
        async def handler():
            body = await self._api_body()
            name = str(body.get("name") or "").strip()
            if not name:
                raise ValueError("缺少 name 参数")
            msg = await self._do_start(name)
            return {"ok": True, "message": msg}

        try:
            return await self._api_response(await handler())
        except (ValueError, RuntimeError) as exc:
            return await self._api_response({"ok": False, "message": str(exc)}, 400)

    async def _api_stop(self):
        async def handler():
            body = await self._api_body()
            name = str(body.get("name") or "").strip()
            if not name:
                raise ValueError("缺少 name 参数")
            msg = await self._do_stop(name)
            return {"ok": True, "message": msg}

        try:
            return await self._api_response(await handler())
        except (ValueError, RuntimeError) as exc:
            return await self._api_response({"ok": False, "message": str(exc)}, 400)

    async def _api_restart(self):
        async def handler():
            body = await self._api_body()
            name = str(body.get("name") or "").strip()
            if not name:
                raise ValueError("缺少 name 参数")
            try:
                await self._do_stop(name)
            except RuntimeError:
                pass  # 没在跑也允许重启（等于启动）
            msg = await self._do_start(name)
            return {"ok": True, "message": msg}

        try:
            return await self._api_response(await handler())
        except (ValueError, RuntimeError) as exc:
            return await self._api_response({"ok": False, "message": str(exc)}, 400)

    async def _api_toggle(self):
        """一键切换：运行中就停，停止中就起。"""

        async def handler():
            body = await self._api_body()
            name = str(body.get("name") or "").strip()
            if not name:
                raise ValueError("缺少 name 参数")
            self._require_name(name)
            port = self._port(name)
            running = not await port_free_async(port)
            if running:
                msg = await self._do_stop(name)
                return {"ok": True, "message": msg, "running": False}
            msg = await self._do_start(name)
            return {"ok": True, "message": msg, "running": True}

        try:
            return await self._api_response(await handler())
        except (ValueError, RuntimeError) as exc:
            return await self._api_response({"ok": False, "message": str(exc)}, 400)
