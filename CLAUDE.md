# 畫圖 App — CLAUDE.md

瀏覽器端 2D/3D 平面圖繪製 app，React 19 + Three.js（React Three Fiber）+ TypeScript。

## 開發指令

**所有指令須在 `app_source/` 目錄下執行。目前無自動化測試。**

```bash
npm run dev      # 啟動開發伺服器，http://localhost:3000
npm run build    # 編譯正式版本 → dist/
npm run preview  # 在本機預覽正式版本
npm run lint     # TypeScript 型別檢查（tsc --noEmit）
```

---

## 關鍵檔案

- **`types.ts`** — 所有介面定義（`IShape`、`IPoint`、`ToolType` 等）
- **`constants.ts`** — `SNAP_GRID`（1mm）、`DEFAULT_HEIGHT`、顏色常數
- **`context/AppContext.tsx`** — 全域狀態、undo/redo、檔案 I/O、自動存檔
- **`components/Viewport.tsx`** — ~4200 行：3D 渲染、吸附、工具邏輯（所有主要功能集中於此）
- **`utils/polygonDetection.ts`** — 半邊遍歷，偵測封閉線段迴圈 → 自動轉為 `flat` 形狀

---

## 核心設計模式

### 雙軌狀態：React state + stateRef

**IMPORTANT：事件處理器必須讀取 `stateRef.current`，絕不能直接讀取 React state（stale closure）。**

```typescript
const stateRef = useRef({ shapes, layers, guideLines, ... });
useEffect(() => { stateRef.current = { shapes, layers, ... }; }, [shapes, layers, ...]);
```

### 預覽 vs 提交

- `updateShapePreview(id, changes)` — 即時更新，不寫入歷史（拖曳 / 滑桿）
- `updateShape(id, changes)` — 提交到 undo 歷史（pointer-up / blur 時）

### 幾何座標慣例

**IMPORTANT：所有 flat/solid 形狀繞 X 軸旋轉 `-π/2`，使其沿世界 Y 軸擠出。此旋轉已烘焙進 CSG 轉換矩陣，修改時必須特別小心。**

### 吸附系統（Viewport.tsx 頂部獨立函式）

- `getGeometrySnap()` — 頂點 / 中點 / 邊線 / 面
- `getAxisSnap()` — 世界 X/Z 原點軸線
- `getGuideLineIntersectionSnap()` — 輔助線交叉點
- `getSnapPoint()` — 協調器；自適應閾值 = `max(0.05, 攝影機距離 × 0.025)`

### CSG（布林切割）

**IMPORTANT：hole 幾何必須轉換到基礎形狀的本地座標空間（世界座標 → 基礎形狀逆矩陣 → 幾何旋轉），且必須納入 `-π/2` X 軸旋轉。**

### 自動存檔（localStorage）

使用兩個獨立 key，禁止合併：

- `buney_autosave` — shapes / layers / guideLines / projectName（2.5s debounce）
- `buney_autosave_bg` — 底圖 base64（獨立存放，隔離 QuotaExceededError）

---

## NEVER 規則

- **NEVER** 將 `backgroundImage` base64 放進主要自動存檔 JSON（可能達數 MB）
- **NEVER** 將形狀 `type` 當 enum 使用，它是字串字面值（如 `'line'`、`'flat'`）

---

## 常見陷阱

- **`finishShape` 回呼** — shapes 永遠是 stale closure，必須讀取 `stateRef.current.shapes` 或傳入新陣列
- **IMPORTANT：`attemptGeometryCut` 回傳 `true` 時，必須跳過 `updatePolygons()` 呼叫**，否則 stale closure 造成重複片段
- **jsPDF** — 使用 dynamic import（`await import('jspdf')`），呼叫函式必須是 `async`
- **OrbitControls** — `enableZoom` / `enablePan` 恆開，`enableRotate` 只在 HAND 工具時啟用，已設定 `zoomToCursor`
- **歷史紀錄上限 50 筆** — commit 後 `historyIndex` 永遠等於 `newHistory.length - 1`

---

## 壓縮指引

當 context 接近上限進行壓縮時，**必須保留**：

- 所有 IMPORTANT 和 NEVER 標記的規則
- stateRef vs React state 雙軌設計說明
- CSG 座標空間轉換邏輯（-π/2 烘焙）
- localStorage 雙 key 設計說明
- `attemptGeometryCut` → 跳過 `updatePolygons` 的條件
