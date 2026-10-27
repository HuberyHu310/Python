"""PokéSurvivor 本機代玩啟動器.

1. 第一次執行會把開源遊戲 (github.com/JPTER78/pokesurvivor) 下載到 ./pokesurvivor-game
2. 在 http://127.0.0.1:<port>/dev.html 架一個本機伺服器
3. 有安裝 Playwright 的話，直接開瀏覽器並注入 extension/autoplay.js 讓 bot 代玩；
   沒有的話，只架伺服器，你用 Chrome 擴充功能 (extension/ 資料夾) 開該網址即可。

範例:
    python run_local.py                    # 開視窗看 bot 玩
    python run_local.py --headless --runs 3  # 背景跑 3 局，印出成績
    python run_local.py --serve-only       # 只架伺服器（配 Chrome 擴充功能用）

需要: Python 3.9+、git；要自動開瀏覽器再加 `pip install playwright && playwright install chromium`
"""

from __future__ import annotations

import argparse
import functools
import json
import shutil
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
BOT_JS = HERE / "extension" / "autoplay.js"
GAME_REPO = "https://github.com/JPTER78/pokesurvivor"


def ensure_game(game_dir: Path) -> None:
    """沒有遊戲就用 git 下載（只抓最新版本）。"""
    if (game_dir / "dev.html").exists():
        return
    if shutil.which("git") is None:
        sys.exit(f"找不到 git。請先安裝 git，或手動下載 {GAME_REPO} 到 {game_dir}")
    print(f"下載遊戲到 {game_dir} （約 100MB，只需一次）…")
    subprocess.run(["git", "clone", "--depth", "1", GAME_REPO, str(game_dir)], check=True)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args) -> None:  # 不要每個檔案都印一行
        pass


def serve(game_dir: Path, port: int) -> ThreadingHTTPServer:
    handler = functools.partial(QuietHandler, directory=str(game_dir))
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def format_runs(runs: list[dict]) -> str:
    lines = []
    for i, r in enumerate(runs, 1):
        lines.append(
            f"  第 {i} 局: 撐了 {r['time']} 秒, Lv{r['level']}, "
            f"擊倒 {r['kills']}, 打倒王 {r['bosses']}"
        )
    return "\n".join(lines)


def play(url: str, headless: bool, runs: int, minutes: float, browser_path: str | None) -> list[dict]:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        launch = {"headless": headless, "args": ["--autoplay-policy=no-user-gesture-required"]}
        if browser_path:
            launch["executable_path"] = browser_path
        browser = p.chromium.launch(**launch)
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.on("pageerror", lambda e: print("[頁面錯誤]", e))
        page.on("console", lambda m: m.text.startswith("[autoplay]") and print(m.text))
        page.add_init_script(path=str(BOT_JS))
        page.goto(url)

        deadline = time.time() + minutes * 60 if minutes > 0 else float("inf")
        last_print = 0.0
        state: dict = {}
        while time.time() < deadline:
            try:
                state = page.evaluate(
                    "() => { const s = window.__psAutoplay; return s ? "
                    "{ runs: s.runs, cur: s.cur || null, gs: window.G && G.Game && G.Game.state } : {} }"
                )
            except Exception as e:  # 頁面重新整理中
                print("讀取狀態失敗:", e)
                state = {}
            done = state.get("runs", [])
            if runs > 0 and len(done) >= runs:
                break
            if time.time() - last_print > 10:
                last_print = time.time()
                cur = state.get("cur")
                if cur and state.get("gs") == "playing":
                    print(f"[進行中] {cur['time']}s Lv{cur['level']} 擊倒 {cur['kills']}  (已完成 {len(done)} 局)")
                else:
                    print(f"[{state.get('gs')}] 已完成 {len(done)} 局")
            page.wait_for_timeout(1000)
        browser.close()
        return state.get("runs", [])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game-dir", type=Path, default=HERE / "pokesurvivor-game", help="遊戲原始碼資料夾")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--headless", action="store_true", help="不開視窗，背景跑")
    ap.add_argument("--runs", type=int, default=0, help="跑幾局後停止（0 = 一直跑）")
    ap.add_argument("--minutes", type=float, default=0, help="最多跑幾分鐘（0 = 不限）")
    ap.add_argument("--serve-only", action="store_true", help="只架伺服器，用 Chrome 擴充功能玩")
    ap.add_argument("--browser-path", help="指定 Chromium/Chrome 執行檔")
    args = ap.parse_args()

    ensure_game(args.game_dir)
    httpd = serve(args.game_dir, args.port)
    url = f"http://127.0.0.1:{args.port}/dev.html"

    def wait_forever() -> None:
        print(f"遊戲網址: {url}")
        print("在 Chrome 載入 extension/ 資料夾（開發人員模式 > 載入未封裝項目）後打開上面網址。Ctrl+C 結束。")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass

    if args.serve_only:
        wait_forever()
        return
    try:
        import playwright  # noqa: F401
    except ImportError:
        print("沒有安裝 Playwright（pip install playwright && playwright install chromium），改為只架伺服器。")
        wait_forever()
        return

    try:
        result = play(url, args.headless, args.runs, args.minutes, args.browser_path)
    except KeyboardInterrupt:
        result = []
    finally:
        httpd.shutdown()
    if result:
        print("成績:\n" + format_runs(result))
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
