# 畫圖 App — 瀏覽器端 2D/3D 平面圖繪製工具

以 React 19 + Three.js（React Three Fiber）+ TypeScript 實作，完全在瀏覽器端運作，無需後端。

## 技術棧

| 分類 | 套件 |
|------|------|
| 3D 渲染 | `@react-three/fiber` + `@react-three/drei` + `three` |
| 布林運算 | `three-bvh-csg` |
| PDF 支援 | `pdfjs-dist`（匯入底圖）、`jspdf`（匯出） |
| UI | React 19、`lucide-react` |

## 快速啟動

```bash
cd app_source
npm install
npm run dev     # http://localhost:3000
```

## 主要功能

- **2D 繪圖** — 線段、多邊形（自動偵測封閉迴圈）、尺寸標註
- **3D 推拉** — 平面形狀擠出為立體，支援 CSG 挖洞
- **吸附系統** — 頂點、中點、邊線、面、輔助線交點，自適應縮放閾值
- **PDF 底圖** — 匯入 PDF 作為繪圖參考底圖
- **圖層管理** — 多圖層顯示 / 隱藏 / 鎖定
- **Undo/Redo** — 歷史紀錄 50 筆上限
- **自動存檔** — localStorage，2.5 秒 debounce

## 開發指令

```bash
npm run dev      # 啟動開發伺服器
npm run build    # 編譯正式版本 → dist/
npm run preview  # 在本機預覽正式版本
npm run lint     # TypeScript 型別檢查（tsc --noEmit）
```

> 所有指令須在 `app_source/` 目錄下執行。
