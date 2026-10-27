# PokéSurvivor 自動代玩

[PokéSurvivor](https://pokesurvivor.com/)（[原始碼](https://github.com/JPTER78/pokesurvivor)）的自動代玩插件。

## 會做什麼

- **走位**：每一幀試 24 個方向，模擬未來 0.1–0.55 秒，挑最安全的方向。它會避開：
  - 敵人（假設敵人會朝你走來），王會保持更遠的距離
  - 敵人的子彈（照子彈的速度預測位置）
  - 地上有預警的光束和圓形範圍攻擊
  - 牆、樹、熔岩、毒沼
  - 被敵人包圍：會往敵人少的那一邊走
- **攻擊距離**：近戰招式會靠近敵人，遠程招式會保持距離（遊戲本身就會自動攻擊）
- **撿東西**：道具、寶珠、經驗；血量低時去泉水補血，路過祭壇會拿加成
- **自動選擇**：
  - 升級三選一：進化 > 新的攻擊招式 > 升級主力招式 > 屬性
  - 撿到第二個道具時：照道具排名決定換不換
  - 羈絆融合：選等級最高的招式來融合
- **招式槽**：主力用傷害最高的那一槽，有增益招式就在快失效時切過去補一下
- **寶珠**：被包圍或血量低時用控場寶珠，打王時用增益寶珠
- **選單**：自動訪客登入、做性格測驗、按「開始」、看完結算再開一局

熱鍵：**F8** 開／關 bot、**F9** 開／關自動重開。你自己按方向鍵時，以你的操作為主。
左下角的小面板會顯示這一局的時間、等級、擊倒數，以及最佳成績。

## 為什麼要用本機版

公開網站 pokesurvivor.com 上的程式是包起來又混淆過的。作者是故意這樣做來防作弊的，
因為遊戲有線上排行榜。這個插件**不會**破解這層保護：在公開網站上，它只會顯示
「讀不到遊戲狀態」，然後什麼都不做。

所以 bot 跑在你電腦上的開源版本（`dev.html`）。它還會把遊戲鎖成**本機模式**：
不連雲端，也不上傳排行榜，所以代玩的成績不會影響其他玩家。
本機模式的存檔只存在你的瀏覽器裡，跟你在 pokesurvivor.com 的帳號是分開的。

## 用法

### 方法一：Python 啟動器（最簡單）

```bash
cd pokesurvivor_autoplay
pip install playwright
playwright install chromium

python run_local.py                      # 開視窗看 bot 玩
python run_local.py --headless --runs 3  # 不開視窗，背景跑 3 局，最後印出成績
```

第一次執行時，會用 git 把遊戲下載到 `pokesurvivor-game/`（大約 100MB），之後不用再下載。

### 方法二：Chrome 擴充功能

1. `python run_local.py --serve-only`（這個不需要 Playwright），然後它會印出網址
   `http://127.0.0.1:8765/dev.html`
2. Chrome 打開 `chrome://extensions`，開啟右上角的「開發人員模式」
3. 按「載入未封裝項目」，選這裡的 `extension/` 資料夾
4. 打開第 1 步的網址，bot 就會開始玩

你也可以用別的方式架這個遊戲，只要網址是 `localhost` 或 `127.0.0.1`，擴充功能就會自動啟用。

## 檔案

| 檔案 | 說明 |
| --- | --- |
| `extension/autoplay.js` | bot 本體（擴充功能和啟動器共用） |
| `extension/manifest.json` | Chrome 擴充功能設定（Manifest V3） |
| `run_local.py` | 下載遊戲、架本機伺服器、用 Playwright 開瀏覽器並注入 bot |

## 調整

在瀏覽器的 Console 可以用 `window.__psAutoplay` 看 bot 的狀態，例如
`__psAutoplay.runs` 是每局的成績，`__psAutoplay.debug = true` 會把每一幀的決策存在 `__psAutoplay.dbg`。
選卡偏好在 `autoplay.js` 的 `STAT_SCORE`、`ITEM_RANK` 和 `scoreCard()`，
走位的權重在 `think()`。

遊戲本身的授權是非商業授權（見原專案的 LICENSE），這個插件只能自己玩。
