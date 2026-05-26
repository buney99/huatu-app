
import React, { useState, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { ToolType, IShape } from '../types';
import {
  MousePointer2,
  Square,
  Circle,
  PenLine,
  Scaling,
  RotateCw,
  Type,
  ArrowLeftRight,
  Hand,
  Ruler,
  Trash,
  Eraser,
  ImagePlus,
} from 'lucide-react';

type ToolCategory = 'navigate' | 'transform' | 'draw' | 'annotate';

interface ToolButtonProps {
  active?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  variant?: 'default' | 'danger' | 'warning';
  category?: ToolCategory;
  onSetTooltip: (e: React.MouseEvent<HTMLElement>, label: string) => void;
  onClearTooltip: () => void;
}

const categoryActiveClass: Record<ToolCategory, string> = {
  navigate:  'bg-slate-700 text-white shadow-md',
  transform: 'bg-violet-500 text-white shadow-md shadow-violet-500/25',
  draw:      'bg-emerald-500 text-white shadow-md shadow-emerald-500/25',
  annotate:  'bg-amber-500 text-white shadow-md shadow-amber-500/25',
};

const categoryHoverClass: Record<ToolCategory, string> = {
  navigate:  'text-slate-500 hover:bg-slate-100 hover:text-slate-700',
  transform: 'text-slate-500 hover:bg-violet-50 hover:text-violet-600',
  draw:      'text-slate-500 hover:bg-emerald-50 hover:text-emerald-600',
  annotate:  'text-slate-500 hover:bg-amber-50 hover:text-amber-600',
};

const ToolButton: React.FC<ToolButtonProps> = React.memo(({
  active = false,
  onClick,
  icon,
  label,
  variant = 'default',
  category = 'navigate',
  onSetTooltip,
  onClearTooltip,
}) => {
  const base = "flex shrink-0 items-center justify-center w-10 h-10 rounded-xl transition-all duration-200 relative";
  let color = '';

  if (variant === 'danger') {
    color = 'text-slate-400 hover:bg-red-50 hover:text-red-500';
  } else if (variant === 'warning') {
    color = 'text-slate-500 hover:bg-amber-50 hover:text-amber-600';
  } else {
    color = active ? categoryActiveClass[category] : categoryHoverClass[category];
  }

  return (
    <button
      onClick={onClick}
      onMouseEnter={(e) => onSetTooltip(e, label)}
      onMouseLeave={onClearTooltip}
      className={`${base} ${color}`}
    >
      {icon}
    </button>
  );
});

const CategoryLabel = ({ label }: { label: string }) => (
  <div className="text-[9px] font-bold tracking-widest text-slate-400 uppercase px-2 pt-2 pb-0.5 text-center select-none">
    {label}
  </div>
);

const CategoryDivider = () => (
  <div className="h-px bg-slate-100 mx-1.5 my-0.5" />
);

// Floor-plan door symbol (SVG icon)
const DoorIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <line x1="3" y1="3" x2="3" y2="9" />
    <line x1="21" y1="3" x2="21" y2="9" />
    <line x1="3" y1="4.5" x2="21" y2="4.5" />
    <path d="M21 4.5 A18 18 0 0 1 3 22.5" />
  </svg>
);

// Scale tool icon: dashed bounding box with filled corner handles
const ScaleIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="5" y="5" width="14" height="14" strokeDasharray="3 2"/>
    <rect x="1.5" y="1.5" width="3" height="3" fill="currentColor" stroke="none" rx="0.5"/>
    <rect x="19.5" y="1.5" width="3" height="3" fill="currentColor" stroke="none" rx="0.5"/>
    <rect x="1.5" y="19.5" width="3" height="3" fill="currentColor" stroke="none" rx="0.5"/>
    <rect x="19.5" y="19.5" width="3" height="3" fill="currentColor" stroke="none" rx="0.5"/>
  </svg>
);

const Toolbar: React.FC = () => {
  const { tool, setTool, guideLines, clearGuideLines, addShape, activeLayerId } = useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      const img = new Image();
      img.onload = () => {
        const aspect = img.width / img.height;
        const defaultH = 2;
        const defaultW = defaultH * aspect;
        addShape({
          id: crypto.randomUUID(),
          layerId: activeLayerId,
          type: 'image',
          points: [
            { x: -0.5, y: 0, z: -0.5 },
            { x:  0.5, y: 0, z: -0.5 },
            { x:  0.5, y: 0, z:  0.5 },
            { x: -0.5, y: 0, z:  0.5 },
          ],
          height: 0,
          color: '#ffffff',
          position: [0, 0.001, 0],
          rotation: [-Math.PI / 2, 0, 0],
          scale: [defaultW, 1, defaultH],
          name: file.name.replace(/\.[^.]+$/, ''),
          imageUrl: dataUrl,
        });
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const [tooltip, setTooltip] = useState<{ label: string; top: number; left: number } | null>(null);

  const handleSetTooltip = (e: React.MouseEvent<HTMLElement>, label: string) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ label, top: rect.top + rect.height / 2, left: rect.right + 12 });
  };

  const handleClearTooltip = () => setTooltip(null);

  // ── Group A: 導航
  const navigateTools = [
    { type: ToolType.SELECT, icon: <MousePointer2 size={22} />, label: "選取 / 移動" },
    { type: ToolType.HAND,   icon: <Hand size={22} />,          label: "畫布漫遊" },
  ];

  // ── Group B: 變形
  const transformTools = [
    { type: ToolType.PUSH_PULL, icon: <Scaling size={22} />,   label: "推拉 (調整尺寸)" },
    { type: ToolType.ROTATE,    icon: <RotateCw size={22} />,   label: "旋轉" },
    { type: ToolType.SCALE,     icon: <ScaleIcon />,            label: "比例縮放 (Scale)" },
  ];

  // ── Group C: 繪製
  const drawTools = [
    { type: ToolType.DRAW_LINE,   icon: <PenLine size={22} />,       label: "畫直線" },
    { type: ToolType.DRAW_RECT,   icon: <Square size={22} />,        label: "畫矩形" },
    { type: ToolType.DRAW_CIRCLE, icon: <Circle size={22} />,        label: "畫圓形" },
    { type: ToolType.DRAW_TEXT,   icon: <Type size={22} />,          label: "文字說明" },
    { type: ToolType.DOOR,        icon: <DoorIcon />,                label: "門 (2D 平面圖)" },
  ];

  // ── Group D: 標記
  const annotateTools = [
    { type: ToolType.GUIDE_LINE, icon: <Ruler size={22} />,          label: "輔助線 (捲尺)" },
    { type: ToolType.DIMENSION,  icon: <ArrowLeftRight size={22} />, label: "尺寸標註" },
    { type: ToolType.ERASER,     icon: <Eraser size={22} />,         label: "橡皮擦" },
  ];

  const renderGroup = (tools: typeof navigateTools, cat: ToolCategory) =>
    tools.map((t) => (
      <ToolButton
        key={t.type}
        active={tool === t.type}
        onClick={() => setTool(t.type)}
        icon={t.icon}
        label={t.label}
        category={cat}
        onSetTooltip={handleSetTooltip}
        onClearTooltip={handleClearTooltip}
      />
    ));

  return (
    <>
      <div className="pointer-events-auto flex flex-col">
        {/* Single unified card */}
        <div className="flex flex-col bg-white p-1.5 rounded-2xl border border-slate-200/80 shadow-[0_4px_24px_rgba(0,0,0,0.09)] max-h-[72vh] overflow-y-auto scrollbar-hide">

          {/* Sticky header */}
          <div className="sticky top-0 bg-white z-30 text-[9px] text-slate-400 font-bold uppercase tracking-widest px-1 py-2 text-center border-b border-slate-100 mb-0.5 select-none">
            工具箱
          </div>

          {/* ── A: 導航 */}
          <CategoryLabel label="導航" />
          {renderGroup(navigateTools, 'navigate')}

          <CategoryDivider />

          {/* ── B: 變形 */}
          <CategoryLabel label="變形" />
          {renderGroup(transformTools, 'transform')}

          <CategoryDivider />

          {/* ── C: 繪製 */}
          <CategoryLabel label="繪製" />
          {renderGroup(drawTools, 'draw')}
          {/* Insert Image lives in Draw group */}
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
          <ToolButton
            onClick={() => fileInputRef.current?.click()}
            icon={<ImagePlus size={22} />}
            label="插入照片"
            category="draw"
            onSetTooltip={handleSetTooltip}
            onClearTooltip={handleClearTooltip}
          />

          <CategoryDivider />

          {/* ── D: 標記 */}
          <CategoryLabel label="標記" />
          {renderGroup(annotateTools, 'annotate')}

          {/* Conditional: delete all guide lines */}
          {guideLines.length > 0 && (
            <>
              <div className="h-px bg-slate-100 mx-1.5 my-0.5" />
              <ToolButton
                onClick={clearGuideLines}
                icon={
                  <div className="relative w-5 h-5">
                    <Ruler size={16} className="absolute top-0 left-0 opacity-50" />
                    <Trash size={14} className="absolute bottom-0 right-0" />
                  </div>
                }
                label="刪除所有輔助線"
                variant="warning"
                onSetTooltip={handleSetTooltip}
                onClearTooltip={handleClearTooltip}
              />
            </>
          )}

        </div>
      </div>

      {/* Floating Tooltip Portal */}
      {tooltip && (
        <div
          className="fixed z-50 px-3 py-1.5 bg-slate-800 text-white text-xs font-medium rounded-full shadow-xl whitespace-nowrap pointer-events-none animate-in fade-in zoom-in-95 duration-150"
          style={{ top: tooltip.top, left: tooltip.left, transform: 'translateY(-50%)' }}
        >
          {tooltip.label}
          <div className="absolute top-1/2 -left-1 w-2 h-2 bg-slate-800 transform -translate-y-1/2 rotate-45" />
        </div>
      )}
    </>
  );
};

export default Toolbar;
