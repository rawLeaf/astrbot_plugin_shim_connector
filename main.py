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
import json
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core import AstrBotConfig

PLUGIN_DIR = Path(__file__).parent
SHIM_DIR = PLUGIN_DIR / "shims"

# 每个 shim 的默认配置。端口与 token 可在 _conf_schema.json 里改。
SHIM_DEFS: dict[str, dict] = {
    "workbuddy": {
        "script": "workbuddy-shim.mjs",
        "port": 8787,
        "token": "sk-workbuddy-local",
        "label": "WorkBuddy",
        "env_prefix": "WB_SHIM",
    },
    "trae": {
        "script": "trae-shim.mjs",
        "port": 8788,
        "token": "sk-trae-local",
        "label": "Trae",
        "env_prefix": "TRAE_SHIM",
    },
    "qoder": {
        "script": "qoder-shim.mjs",
        "port": 8789,
        "token": "sk-qoder-local",
        "label": "Qoder",
        "env_prefix": "QODER_SHIM",
    },
}


def port_free(port: int) -> bool:
    """端口是否空闲。

    Args:
        port: 要检查的端口。

    Returns:
        True 表示可以绑定。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) != 0


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

    def _enabled(self, name: str) -> bool:
        """该 shim 是否启用。"""
        section = self.config.get(name, {}) if isinstance(self.config, dict) else {}
        return bool(section.get("enable", name == "trae"))

    def _port(self, name: str) -> int:
        """取端口，配置优先。"""
        section = self.config.get(name, {}) if isinstance(self.config, dict) else {}
        try:
            return int(section.get("port") or SHIM_DEFS[name]["port"])
        except (TypeError, ValueError):
            return int(SHIM_DEFS[name]["port"])

    def _token(self, name: str) -> str:
        """取占位 token，配置优先。"""
        section = self.config.get(name, {}) if isinstance(self.config, dict) else {}
        return str(section.get("token") or SHIM_DEFS[name]["token"])

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

        started = []
        for name in SHIM_DEFS:
            if not self._enabled(name):
                logger.info(f"[shim_connector] {name} 未启用，跳过")
                continue
            ok = await self._start_shim(name, node)
            if ok:
                started.append(name)

        if not started:
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
        spec = SHIM_DEFS[name]
        script = SHIM_DIR / spec["script"]
        if not script.is_file():
            logger.error(f"[shim_connector] 缺少脚本 {script}")
            return False

        port = self._port(name)
        if not port_free(port):
            logger.info(f"[shim_connector] {name} 端口 {port} 已被占用，视为已在运行")
            return True

        env = os.environ.copy()
        env[f"{spec['env_prefix']}_PORT"] = str(port)
        env[f"{spec['env_prefix']}_TOKEN"] = self._token(name)
        env.setdefault("PYTHONIOENCODING", "utf-8")
        env.setdefault("PYTHONUTF8", "1")

        try:
            creation = 0
            if sys.platform == "win32":
                creation = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            proc = subprocess.Popen(
                [node, str(script)],
                cwd=str(script.parent),
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creation,
            )
            self.procs[name] = proc
            logger.info(f"[shim_connector] 已启动 {name} (:{port}) pid={proc.pid}")
            return True
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[shim_connector] 启动 {name} 失败: {exc}")
            return False

    # ── Provider 注册 ───────────────────────────────────────────

    async def _register_provider(self, name: str) -> None:
        """把该 shim 注册成 AstrBot 的模型 provider。"""
        port = self._port(name)
        token = self._token(name)

        models = await self._fetch_models(port, token)
        if not models:
            logger.warning(f"[shim_connector] {name} 未返回模型列表，跳过注册")
            return

        base_id = f"shim_{name}"
        for idx, model_id in enumerate(models):
            pid = base_id if len(models) == 1 else f"{base_id}_{idx}"
            if pid in self.registered:
                continue

            try:
                existing = await self.context.provider_manager.get_provider_by_id(pid)
                if existing is not None:
                    self.registered.add(pid)
                    logger.info(f"[shim_connector] provider {pid} 已存在，跳过")
                    continue
            except Exception:  # noqa: BLE001
                pass

            cfg = {
                "id": pid,
                "type": "openai_chat_completion",
                "provider_type": "chat_completion",
                "provider": "openai",
                "enable": True,
                "key": [token],
                "api_base": f"http://127.0.0.1:{port}/v1",
                "model": model_id,
                "timeout": 240,
                "proxy": "",
                "custom_headers": {},
                "modalities": ["text", "tool_use"],
            }
            try:
                await self.context.provider_manager.create_provider(cfg)
                self.registered.add(pid)
                logger.info(f"[shim_connector] 已注册 {pid} -> {model_id} (:{port})")
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
        import urllib.request

        url = f"http://127.0.0.1:{port}/v1/models"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310
                doc = json.loads(resp.read().decode("utf-8"))
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
            for name in SHIM_DEFS:
                if not self._enabled(name):
                    continue
                ok = await self._start_shim(name, node)
                results.append(f"{SHIM_DEFS[name]['label']}: {'已启动' if ok else '失败'}")
            await asyncio.sleep(2.0)
            for name in SHIM_DEFS:
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
            for name in SHIM_DEFS:
                if self._enabled(name):
                    await self._start_shim(name, node)
            await asyncio.sleep(2.0)
            for name in SHIM_DEFS:
                if self._enabled(name):
                    await self._register_provider(name)
            yield event.plain_result("已重启。\n\n" + self._status_text())
            return

        yield event.plain_result(f"未知操作 {action}。用法：/shim [status|start|stop|restart]")

    def _status_text(self) -> str:
        """生成状态文本。"""
        lines = ["本机 shim 状态", ""]
        for name, spec in SHIM_DEFS.items():
            port = self._port(name)
            enabled = self._enabled(name)
            running = not port_free(port)
            proc = self.procs.get(name)
            pid = proc.pid if proc and proc.poll() is None else "-"
            mark = "[运行]" if running else "[停止]"
            state = "" if enabled else " (未启用)"
            lines.append(
                f"{mark} {spec['label']:<12} :{port:<6} pid={pid}{state}"
            )
        return "\n".join(lines)
