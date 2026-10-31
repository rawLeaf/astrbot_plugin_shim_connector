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
import socket
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import ClassVar

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core import AstrBotConfig

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


def port_free(port: int) -> bool:
    """同步版端口探测，仅供纯同步上下文用（如状态文本渲染）。

    异步路径请用 :func:`port_free_async`。

    Args:
        port: 要检查的端口。

    Returns:
        True 表示可以绑定。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) != 0


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

    def _node_exe(self) -> str | None:
        """找 node 可执行文件。"""
        section = self.config.get("advanced", {}) if isinstance(self.config, dict) else {}
        custom = str(section.get("node_path") or "").strip()
        if custom and Path(custom).is_file():
            return custom
        found = shutil.which("node")
        if found:
            return found
        # Windows 常见安装位置兜底
        for cand in (
            r"D:\3other\nodejs\node.exe",
            r"C:\Program Files\nodejs\node.exe",
        ):
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
        started = []
        for name in all_defs:
            if not self._enabled(name):
                logger.debug(f"[shim_connector] {name} 未在总开关里，跳过")
                continue
            ok = await self._start_shim(name, node)
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

    async def terminate(self):
        """插件卸载时：停掉所有 shim。"""
        for name, proc in list(self.procs.items()):
            self._stop_shim(name, proc)
        self.procs.clear()
        self.registered.clear()

    def _stop_shim(self, name: str, proc: subprocess.Popen) -> None:
        """停一个 shim 进程。"""
        if proc.poll() is not None:
            return
        try:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            logger.info(f"[shim_connector] 已停止 {name}")
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[shim_connector] 停止 {name} 失败: {exc}")

    async def _start_shim(self, name: str, node: str) -> bool:
        """起一个 shim 子进程。

        Args:
            name: shim 名。
            node: node 可执行文件路径。

        Returns:
            True 表示已启动或已在运行。
        """
        spec = self._all_defs()[name]
        script = Path(spec["script"]) if Path(spec["script"]).is_absolute() else SHIM_DIR / spec["script"]
        if not script.is_file():
            logger.error(f"[shim_connector] 缺少脚本 {script}")
            return False

        port = self._port(name)
        if not await port_free_async(port):
            logger.info(f"[shim_connector] {name} 端口 {port} 已被占用，视为已在运行")
            return True

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

    def _log_dir(self) -> Path:
        """日志目录：优先 plugin_data，其次插件目录下 logs/。"""
        base = PLUGIN_DIR.parent.parent / "plugin_data" / PLUGIN_DIR.name
        try:
            base.mkdir(parents=True, exist_ok=True)
            return base
        except Exception:  # noqa: BLE001
            fb = PLUGIN_DIR / "logs"
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
            yield event.plain_result(self._status_text())
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
            yield event.plain_result("\n".join(results) + "\n\n" + self._status_text())
            return

        if action == "stop":
            for name, proc in list(self.procs.items()):
                self._stop_shim(name, proc)
            self.procs.clear()
            yield event.plain_result("已停止所有由插件启动的 shim。\n\n" + self._status_text())
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
            yield event.plain_result("已重启。\n\n" + self._status_text())
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

    def _status_text(self) -> str:
        """生成状态文本。"""
        lines = ["本机 shim 状态", ""]
        for name, spec in self._all_defs().items():
            port = self._port(name)
            enabled = self._enabled(name)
            running = not port_free(port)
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
