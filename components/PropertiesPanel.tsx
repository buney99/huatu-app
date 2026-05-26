
import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { PRESET_COLORS } from '../constants';
import { Trash2, Copy, Maximize, Layers, ArrowUpFromLine, RefreshCw, FlipHorizontal2, Scissors } from 'lucide-react';
import { IPoint } from '../types';

// Helper to determine local bounding box from points
const getRawDimensions = (points: IPoint[]) => {
  if (points.length === 0) return { width: 0, depth: 0 };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  points.forEach(p => {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  });
  return { 
    width: maxX - minX || 0.1, 
    depth: maxZ - minZ || 0.1 
  };
};

const calculatePolygonArea = (points: IPoint[]) => {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].z - points[j].x * points[i].z;
  }
  return Math.abs(area / 2);
};

const PropertiesPanel: React.FC = () => {
  const { selectedIds, shapes, updateShape, updateShapePreview, updateShapes, removeSelected, copySelected, formatValue, unit, layers, decomposeFlat } = useApp();

  // Local name state: prevents one history entry per keystroke.
  // The actual commit happens onBlur / Enter.
  const [localName, setLocalName] = useState('');
  const [localElevation, setLocalElevation] = useState('');

  // Compute selected shape early so hooks can reference it
  const selectedShape = selectedIds.length === 1 ? shapes.find(s => s.id === selectedIds[0]) : null;

  useEffect(() => {
    if (selectedShape) {
      setLocalName(selectedShape.name);
      const raw = selectedShape.position[1];
      setLocalElevation(unit === 'cm' ? (raw * 100).toFixed(1) : raw.toFixed(3));
    }
  }, [selectedShape?.id, unit]);

  if (selectedIds.length === 0) {
    return null;
  }

  // --- Multi Selection View ---
  if (selectedIds.length > 1) {
      const selectedShapes = shapes.filter(s => selectedIds.includes(s.id));

      // Compute representative values (first shape as reference)
      const refShape = selectedShapes[0];
      const allSameHeight = selectedShapes.every(s => s.height === refShape.height);
      const allSameElevation = selectedShapes.every(s => s.position[1] === refShape.position[1]);
      const allSameLayer = selectedShapes.every(s => s.layerId === refShape.layerId);

      const multiHeight = allSameHeight ? refShape.height : null;
      const multiElevation = allSameElevation ? refShape.position[1] : null;
      const multiLayerId = allSameLayer ? refShape.layerId : '';

      const getUnitValM = (val: number) => unit === 'cm' ? parseFloat((val * 100).toFixed(1)) : parseFloat(val.toFixed(3));
      const setUnitValM = (val: number) => unit === 'cm' ? val / 100 : val;

      return (
        <div className="absolute top-4 right-4 w-72 bg-slate-800/90 backdrop-blur-md rounded-xl border border-slate-700 shadow-2xl z-30 flex flex-col overflow-hidden max-h-[calc(100vh-6rem)] overflow-y-auto animate-in fade-in slide-in-from-right-2">
            <div className="p-3 border-b border-slate-700 bg-slate-900/50 flex justify-between items-center sticky top-0 z-20">
                <h3 className="text-white font-semibold text-base flex items-center gap-2">
                    <Layers size={14} className="text-blue-500"/>
                    <span>已選取 {selectedIds.length} 個物件</span>
                </h3>
                <div className="flex gap-1">
                    <button
                        onClick={copySelected}
                        className="text-indigo-400 hover:text-indigo-300 p-1.5 hover:bg-indigo-500/10 rounded transition-colors"
                        title="複製選取物件"
                    >
                        <Copy size={16} />
                    </button>
                    <button
                        onClick={removeSelected}
                        className="text-red-400 hover:text-red-300 p-1.5 hover:bg-red-500/10 rounded transition-colors"
                        title="刪除選取物件"
                    >
                        <Trash2 size={16} />
                    </button>
                </div>
            </div>
            <div className="p-4 space-y-4">

                {/* Batch Layer */}
                <div className="space-y-2">
                    <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider flex items-center gap-1">
                        <Layers size={10}/> 批次移動圖層
                    </label>
                    <select
                        value={multiLayerId}
                        onChange={(e) => {
                            const layerId = e.target.value;
                            if (!layerId) return;
                            const updates = selectedIds.map(id => ({ id, changes: { layerId } }));
                            updateShapes(updates);
                        }}
                        className="w-full bg-slate-900/80 border border-slate-600 rounded-lg px-3 py-1.5 text-white text-base focus:border-blue-500 focus:outline-none transition-colors appearance-none"
                    >
                        {!allSameLayer && <option value="">— 混合圖層 —</option>}
                        {layers.map(layer => (
                            <option key={layer.id} value={layer.id}>{layer.name}</option>
                        ))}
                    </select>
                </div>

                {/* Batch Elevation */}
                <div className="space-y-2 pt-2 border-t border-slate-700">
                    <div className="flex justify-between items-center">
                        <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider flex items-center gap-1">
                            <ArrowUpFromLine size={10}/> 批次離地高度
                        </label>
                        <div className="flex items-center gap-1">
                            <input
                                type="number"
                                step={unit === 'm' ? 0.1 : 10}
                                placeholder={multiElevation === null ? '混合' : undefined}
                                value={multiElevation !== null ? getUnitValM(multiElevation) : ''}
                                onChange={(e) => {
                                    const newY = setUnitValM(parseFloat(e.target.value));
                                    if (isNaN(newY)) return;
                                    const updates = selectedIds.map(id => {
                                        const s = shapes.find(sh => sh.id === id)!;
                                        return { id, changes: { position: [s.position[0], newY, s.position[2]] as [number,number,number] } };
                                    });
                                    updateShapes(updates);
                                }}
                                className="w-20 bg-slate-900/80 border border-slate-600 rounded px-2 py-1 text-white text-base font-mono focus:border-green-500 outline-none text-right transition-colors"
                            />
                            <span className="text-[13px] text-slate-500">{unit === 'cm' ? 'cm' : 'm'}</span>
                        </div>
                    </div>
                    <input
                        type="range"
                        min="0" max="3" step="0.01"
                        value={multiElevation ?? 0}
                        onChange={(e) => {
                            const newY = parseFloat(e.target.value);
                            const updates = selectedIds.map(id => {
                                const s = shapes.find(sh => sh.id === id)!;
                                return { id, changes: { position: [s.position[0], newY, s.position[2]] as [number,number,number] } };
                            });
                            // preview only
                            updates.forEach(u => updateShapePreview(u.id, u.changes));
                        }}
                        onPointerUp={(e) => {
                            const newY = parseFloat((e.target as HTMLInputElement).value);
                            const updates = selectedIds.map(id => {
                                const s = shapes.find(sh => sh.id === id)!;
                                return { id, changes: { position: [s.position[0], newY, s.position[2]] as [number,number,number] } };
                            });
                            updateShapes(updates);
                        }}
                        className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-green-500"
                    />
                </div>

                {/* Batch Height */}
                <div className="space-y-2 pt-2 border-t border-slate-700">
                    <div className="flex justify-between items-center">
                        <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider">批次厚度 / 高度</label>
                        <div className="flex items-center gap-1">
                            <input
                                type="number"
                                step={unit === 'm' ? 0.1 : 5}
                                placeholder={multiHeight === null ? '混合' : undefined}
                                value={multiHeight !== null ? getUnitValM(multiHeight) : ''}
                                onChange={(e) => {
                                    const h = setUnitValM(parseFloat(e.target.value));
                                    if (isNaN(h) || h <= 0) return;
                                    const updates = selectedIds.map(id => ({ id, changes: { height: h } }));
                                    updateShapes(updates);
                                }}
                                className="w-20 bg-slate-900/80 border border-slate-600 rounded px-2 py-1 text-white text-base font-mono focus:border-slate-400 outline-none text-right transition-colors"
                            />
                            <span className="text-[13px] text-slate-500">{unit === 'cm' ? 'cm' : 'm'}</span>
                        </div>
                    </div>
                    <input
                        type="range"
                        min="0.05" max="5" step="0.05"
                        value={multiHeight ?? 0.05}
                        onChange={(e) => {
                            const h = parseFloat(e.target.value);
                            selectedIds.forEach(id => updateShapePreview(id, { height: h }));
                        }}
                        onPointerUp={(e) => {
                            const h = parseFloat((e.target as HTMLInputElement).value);
                            const updates = selectedIds.map(id => ({ id, changes: { height: h } }));
                            updateShapes(updates);
                        }}
                        className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    />
                </div>

                {/* Batch Color Picker */}
                <div className="space-y-2 pt-2 border-t border-slate-700">
                    <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider">批次修改顏色</label>
                    <div className="grid grid-cols-5 gap-2">
                        {PRESET_COLORS.map(color => (
                        <button
                            key={color}
                            onClick={() => {
                                const updates = selectedIds.map(id => ({ id, changes: { color } }));
                                updateShapes(updates);
                            }}
                            className="w-full aspect-square rounded-lg border-2 border-transparent hover:scale-105 transition-transform shadow-sm"
                            style={{ backgroundColor: color }}
                        />
                        ))}
                        <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-gradient-to-br from-white to-black border border-slate-600 hover:scale-110 transition-transform shadow-sm">
                            <input
                                type="color"
                                className="absolute inset-0 w-[150%] h-[150%] -top-1/4 -left-1/4 cursor-pointer opacity-0"
                                onChange={(e) => {
                                    const color = e.target.value;
                                    const updates = selectedIds.map(id => ({ id, changes: { color } }));
                                    updateShapes(updates);
                                }}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
      );
  }

  // --- Single Selection View ---
  if (!selectedShape) return null;

  // Calculate current real-world dimensions
  const rawDims = getRawDimensions(selectedShape.points);
  const currentWidth = rawDims.width * selectedShape.scale[0];
  const currentDepth = rawDims.depth * selectedShape.scale[2];

  const rawArea = calculatePolygonArea(selectedShape.points);
  const currentArea = rawArea * selectedShape.scale[0] * selectedShape.scale[2];

  const isCircle = selectedShape.name === '圓形' || (selectedShape.id?.startsWith('circle-') ?? false);
  const currentRadius = currentWidth / 2;

  // Simple numeric updates (Standard center-based scaling for manual input)
  const handleDimensionChange = (newVal: number, type: 'width' | 'depth' | 'radius') => {
    if (isNaN(newVal) || newVal <= 0) return;
    if (type === 'radius') {
      const diameter = newVal * 2;
      const baseW = rawDims.width;
      const baseD = rawDims.depth;
      if (baseW < 0.001 || baseD < 0.001) return;
      const newScale = [...selectedShape.scale] as [number, number, number];
      newScale[0] = diameter / baseW;
      newScale[2] = diameter / baseD;
      updateShape(selectedShape.id, { scale: newScale });
      return;
    }
    const baseSize = type === 'width' ? rawDims.width : rawDims.depth;
    if (baseSize < 0.001) return;
    const newScaleVal = newVal / baseSize;

    const newScale = [...selectedShape.scale] as [number, number, number];
    if (type === 'width') newScale[0] = newScaleVal;
    if (type === 'depth') newScale[2] = newScaleVal;

    updateShape(selectedShape.id, { scale: newScale });
  };

  const getUnitVal = (val: number) => unit === 'cm' ? parseFloat((val * 100).toFixed(1)) : parseFloat(val.toFixed(3));
  const setUnitVal = (val: number) => unit === 'cm' ? val / 100 : val;

  const toDegrees = (rad: number) => Math.round((rad * 180) / Math.PI);
  const toRadians = (deg: number) => (deg * Math.PI) / 180;

  return (
    <div className="absolute top-4 right-4 w-72 bg-slate-800/90 backdrop-blur-md rounded-xl border border-slate-700 shadow-2xl z-30 flex flex-col overflow-hidden max-h-[calc(100vh-6rem)] overflow-y-auto animate-in fade-in slide-in-from-right-2">
      <div className="p-3 border-b border-slate-700 bg-slate-900/50 flex justify-between items-center sticky top-0 z-20">
        <h3 className="text-white font-semibold text-base flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]`}/>
          物件屬性
        </h3>
        <div className="flex gap-1">
          <button 
            onClick={copySelected}
            className="text-indigo-400 hover:text-indigo-300 p-1.5 hover:bg-indigo-500/10 rounded transition-colors"
            title="複製物件"
          >
            <Copy size={16} />
          </button>
          <button 
            onClick={removeSelected}
            className="text-red-400 hover:text-red-300 p-1.5 hover:bg-red-500/10 rounded transition-colors"
            title="刪除物件"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="p-4 space-y-5">
        
        {/* Name */}
        <div className="space-y-2">
            <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider">名稱</label>
            <input
                type="text"
                value={localName}
                onChange={(e) => setLocalName(e.target.value)}
                onBlur={() => {
                    if (localName !== selectedShape.name) {
                        updateShape(selectedShape.id, { name: localName });
                    }
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                className="w-full bg-slate-900/80 border border-slate-600 rounded-lg px-3 py-1.5 text-white text-base focus:border-blue-500 focus:outline-none transition-colors"
            />
        </div>

        {/* Layer */}
        <div className="space-y-2 pt-2 border-t border-slate-700">
            <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider">所屬圖層</label>
            <select
                value={selectedShape.layerId}
                onChange={(e) => updateShape(selectedShape.id, { layerId: e.target.value })}
                className="w-full bg-slate-900/80 border border-slate-600 rounded-lg px-3 py-1.5 text-white text-base focus:border-blue-500 focus:outline-none transition-colors appearance-none"
            >
                {layers.map(layer => (
                    <option key={layer.id} value={layer.id}>{layer.name}</option>
                ))}
            </select>
        </div>

        {/* Text Content - Only for Text shapes */}
        {selectedShape.type === 'text' && (
             <div className="space-y-2 pt-2 border-t border-slate-700">
                <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider">文字內容</label>
                <textarea 
                    value={selectedShape.content || ''} 
                    onChange={(e) => updateShape(selectedShape.id, { content: e.target.value })}
                    className="w-full bg-slate-900/80 border border-slate-600 rounded-lg px-3 py-2 text-white text-base focus:border-blue-500 focus:outline-none resize-none h-20"
                />
                 <div className="flex justify-between items-center mt-3">
                     <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider">字體大小</label>
                     <input 
                        type="number" 
                        step={0.1}
                        value={selectedShape.fontSize || 0.5}
                        onChange={(e) => updateShape(selectedShape.id, { fontSize: parseFloat(e.target.value) })}
                        className="w-20 bg-slate-900/80 border border-slate-600 rounded px-2 py-1 text-white text-base font-mono focus:border-blue-500 outline-none text-right"
                     />
                 </div>
            </div>
        )}

        {/* Door Controls */}
        {selectedShape.type === 'door' && (
            <div className="space-y-4 pt-2 border-t border-slate-700">
                {/* Width */}
                <div className="flex justify-between items-center">
                    <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider">寬度 (Width)</label>
                    <div className="flex items-center gap-1">
                        <input
                            type="number"
                            step={unit === 'm' ? 0.05 : 5}
                            min={unit === 'm' ? 0.5 : 50}
                            value={getUnitVal(selectedShape.scale[0])}
                            onChange={(e) => {
                                const v = setUnitVal(parseFloat(e.target.value));
                                if (isNaN(v) || v <= 0) return;
                                updateShape(selectedShape.id, { scale: [v, 1, v] });
                            }}
                            className="w-20 bg-slate-900/80 border border-slate-600 rounded px-2 py-1 text-white text-base font-mono focus:border-blue-500 outline-none text-right transition-colors"
                        />
                        <span className="text-[13px] text-slate-500">{unit}</span>
                    </div>
                </div>

                {/* Direction */}
                <div className="space-y-2">
                    <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider">門方向 (Direction)</label>
                    <div className="flex gap-2">
                        {(['left', 'right'] as const).map((dir) => (
                            <button
                                key={dir}
                                onClick={() => updateShape(selectedShape.id, { doorDirection: dir })}
                                className={`flex-1 py-1.5 rounded-lg text-base font-medium transition-colors border ${
                                    (selectedShape.doorDirection ?? 'left') === dir
                                        ? 'bg-blue-600 border-blue-500 text-white'
                                        : 'bg-slate-900/60 border-slate-600 text-slate-300 hover:border-slate-400'
                                }`}
                            >
                                {dir === 'left' ? '左開' : '右開'}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Flip */}
                <button
                    onClick={() => updateShape(selectedShape.id, { doorFlipped: !(selectedShape.doorFlipped ?? false) })}
                    className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg text-base font-medium border transition-colors ${
                        selectedShape.doorFlipped
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'bg-slate-900/60 border-slate-600 text-slate-300 hover:border-slate-400'
                    }`}
                >
                    <FlipHorizontal2 size={16} />
                    翻轉 (Flip)
                </button>
            </div>
        )}

        {/* Line Width - Only for Line shapes */}
        {selectedShape.type === 'line' && (
             <div className="space-y-2 pt-2 border-t border-slate-700">
                 <div className="flex justify-between items-center mt-3">
                     <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider">線條寬度 (例如牆面)</label>
                     <div className="flex items-center gap-1">
                         <input 
                            type="number" 
                            step={unit === 'm' ? 0.01 : 1}
                            value={getUnitVal(selectedShape.lineWidth || 0)}
                            onChange={(e) => updateShape(selectedShape.id, { lineWidth: setUnitVal(parseFloat(e.target.value)) })}
                            className="w-20 bg-slate-900/80 border border-slate-600 rounded px-2 py-1 text-white text-base font-mono focus:border-blue-500 outline-none text-right"
                         />
                         <span className="text-base text-slate-400">{unit}</span>
                     </div>
                 </div>
            </div>
        )}

        {/* --- Image Dimensions Section --- */}
        {selectedShape.type === 'image' && (
            <div className="space-y-3 pt-2 border-t border-slate-700">
                <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider flex items-center gap-1">
                    圖片尺寸 <Maximize size={10}/>
                </label>
                <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                        <div className="w-6 text-center text-red-400 font-bold font-mono text-[13px] bg-red-500/10 rounded px-1">W</div>
                        <input
                            type="number"
                            step={unit === 'm' ? 0.1 : 10}
                            value={getUnitVal(selectedShape.scale[0])}
                            onChange={(e) => {
                                const v = setUnitVal(parseFloat(e.target.value));
                                if (isNaN(v) || v <= 0) return;
                                const newScale = [...selectedShape.scale] as [number, number, number];
                                newScale[0] = v;
                                updateShape(selectedShape.id, { scale: newScale });
                            }}
                            className="flex-1 bg-slate-900/80 border border-slate-600 rounded px-2 py-1 text-white text-base font-mono focus:border-red-500 outline-none transition-colors"
                        />
                        <span className="text-[13px] text-slate-500">{unit}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="w-6 text-center text-green-400 font-bold font-mono text-[13px] bg-green-500/10 rounded px-1">H</div>
                        <input
                            type="number"
                            step={unit === 'm' ? 0.1 : 10}
                            value={getUnitVal(selectedShape.scale[2])}
                            onChange={(e) => {
                                const v = setUnitVal(parseFloat(e.target.value));
                                if (isNaN(v) || v <= 0) return;
                                const newScale = [...selectedShape.scale] as [number, number, number];
                                newScale[2] = v;
                                updateShape(selectedShape.id, { scale: newScale });
                            }}
                            className="flex-1 bg-slate-900/80 border border-slate-600 rounded px-2 py-1 text-white text-base font-mono focus:border-green-500 outline-none transition-colors"
                        />
                        <span className="text-[13px] text-slate-500">{unit}</span>
                    </div>
                </div>
                {/* 透明度拉桿 */}
                <div className="space-y-1">
                    <div className="flex items-center justify-between">
                        <label className="text-[13px] text-slate-400">照片透明度</label>
                        <span className="text-[13px] text-slate-300 font-mono">
                            {Math.round((selectedShape.opacity ?? 1) * 100)}%
                        </span>
                    </div>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={selectedShape.opacity ?? 1}
                        onChange={(e) => {
                            updateShapePreview(selectedShape.id, { opacity: parseFloat(e.target.value) });
                        }}
                        onPointerUp={(e) => {
                            updateShape(selectedShape.id, { opacity: parseFloat((e.target as HTMLInputElement).value) });
                        }}
                        className="w-full accent-blue-500"
                    />
                </div>
            </div>
        )}

        {/* --- Dimensions Section --- */}
        {selectedShape.type !== 'text' && selectedShape.type !== 'line' && selectedShape.type !== 'image' && selectedShape.type !== 'door' && (
            <div className="space-y-3 pt-2 border-t border-slate-700">
            <div className="flex justify-between items-center mb-1">
                <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider flex items-center gap-1">
                    尺寸 <Maximize size={10}/>
                </label>
            </div>

            <div className="flex gap-2">
                <div className="flex-1 space-y-2">
                {isCircle ? (
                    <div className="flex items-center gap-2">
                        <div className="w-6 text-center text-purple-400 font-bold font-mono text-[13px] bg-purple-500/10 rounded px-1">R</div>
                        <input
                        type="number"
                        step={unit === 'm' ? 0.1 : 10}
                        value={getUnitVal(currentRadius)}
                        onChange={(e) => handleDimensionChange(setUnitVal(parseFloat(e.target.value)), 'radius')}
                        className="flex-1 bg-slate-900/80 border border-slate-600 rounded px-2 py-1 text-white text-base font-mono focus:border-purple-500 outline-none transition-colors"
                        />
                    </div>
                ) : (
                    <>
                    <div className="flex items-center gap-2">
                        <div className="w-6 text-center text-red-400 font-bold font-mono text-[13px] bg-red-500/10 rounded px-1">W</div>
                        <input
                        type="number"
                        step={unit === 'm' ? 0.1 : 10}
                        value={getUnitVal(currentWidth)}
                        onChange={(e) => handleDimensionChange(setUnitVal(parseFloat(e.target.value)), 'width')}
                        className="flex-1 bg-slate-900/80 border border-slate-600 rounded px-2 py-1 text-white text-base font-mono focus:border-red-500 outline-none transition-colors"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="w-6 text-center text-blue-400 font-bold font-mono text-[13px] bg-blue-500/10 rounded px-1">D</div>
                        <input
                        type="number"
                        step={unit === 'm' ? 0.1 : 10}
                        value={getUnitVal(currentDepth)}
                        onChange={(e) => handleDimensionChange(setUnitVal(parseFloat(e.target.value)), 'depth')}
                        className="flex-1 bg-slate-900/80 border border-slate-600 rounded px-2 py-1 text-white text-base font-mono focus:border-blue-500 outline-none transition-colors"
                        />
                    </div>
                    </>
                )}
                </div>
            </div>
            {selectedShape.type === 'flat' && (
                <>
                <div className="flex justify-between items-center mt-2 bg-slate-900/50 p-2 rounded border border-slate-700">
                    <label className="text-[13px] text-slate-400 font-bold uppercase tracking-wider">面積</label>
                    <div className="text-base text-white font-mono">
                        {unit === 'cm' ? (currentArea * 10000).toFixed(1) : currentArea.toFixed(2)} {unit === 'cm' ? 'cm²' : 'm²'}
                    </div>
                </div>
                <button
                    onClick={() => decomposeFlat(selectedShape.id)}
                    className="w-full flex items-center justify-center gap-2 mt-2 px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 hover:border-amber-500/60 text-amber-400 hover:text-amber-300 rounded text-[13px] font-medium transition-colors"
                    title="將平面分解為可單獨編輯的邊框線段"
                >
                    <Scissors size={13} />
                    分解框架
                </button>
                </>
            )}
            </div>
        )}

        {/* Elevation (Y Position) */}
        <div className="space-y-3 pt-2 border-t border-slate-700">
          <div className="flex justify-between items-center">
             <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider flex items-center gap-1">
                <ArrowUpFromLine size={10}/> 離地高度
             </label>
             <div className="flex items-center gap-1">
                 <input
                    type="number"
                    step={unit === 'm' ? 0.1 : 10}
                    value={localElevation}
                    onChange={(e) => setLocalElevation(e.target.value)}
                    onBlur={() => {
                        const v = parseFloat(localElevation);
                        if (!isNaN(v)) {
                            const newY = setUnitVal(v);
                            const newPos = [...selectedShape.position] as [number, number, number];
                            newPos[1] = newY;
                            updateShape(selectedShape.id, { position: newPos });
                        } else {
                            const raw = selectedShape.position[1];
                            setLocalElevation(unit === 'cm' ? (raw * 100).toFixed(1) : raw.toFixed(3));
                        }
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') {
                            const raw = selectedShape.position[1];
                            setLocalElevation(unit === 'cm' ? (raw * 100).toFixed(1) : raw.toFixed(3));
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    className="w-20 bg-slate-900/80 border border-slate-600 rounded px-2 py-1 text-white text-base font-mono focus:border-green-500 outline-none text-right transition-colors"
                 />
                 <span className="text-[13px] text-slate-500">{unit === 'cm' ? 'cm' : 'm'}</span>
             </div>
          </div>
          <input
            type="range"
            min="0"
            max="6"
            step="0.01"
            value={selectedShape.position[1]}
            onChange={(e) => {
                const newPos = [...selectedShape.position] as [number, number, number];
                newPos[1] = parseFloat(e.target.value);
                updateShapePreview(selectedShape.id, { position: newPos });
                setLocalElevation(unit === 'cm' ? (newPos[1] * 100).toFixed(1) : newPos[1].toFixed(3));
            }}
            onPointerUp={(e) => {
                const newPos = [...selectedShape.position] as [number, number, number];
                newPos[1] = parseFloat((e.target as HTMLInputElement).value);
                updateShape(selectedShape.id, { position: newPos });
                setLocalElevation(unit === 'cm' ? (newPos[1] * 100).toFixed(1) : newPos[1].toFixed(3));
            }}
            className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-green-500"
          />
        </div>

        {/* Height Slider (Extrusion) - Not for Text / Line / Image */}
        {selectedShape.type !== 'text' && selectedShape.type !== 'line' && selectedShape.type !== 'image' && selectedShape.type !== 'door' && (
            <div className="space-y-3 pt-2 border-t border-slate-700">
            <div className="flex justify-between items-center">
                <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider">厚度 / 高度</label>
                <div className="flex items-center gap-1">
                    <input 
                        type="number" 
                        step={unit === 'm' ? 0.1 : 5}
                        value={getUnitVal(selectedShape.height)}
                        onChange={(e) => updateShape(selectedShape.id, { height: setUnitVal(parseFloat(e.target.value)) })}
                        className="w-20 bg-slate-900/80 border border-slate-600 rounded px-2 py-1 text-white text-base font-mono focus:border-green-500 outline-none text-right transition-colors"
                    />
                    <span className="text-[13px] text-slate-500">{unit === 'cm' ? 'cm' : 'm'}</span>
                </div>
            </div>
            <input
                type="range"
                min="0.05"
                max="5"
                step="0.05"
                value={selectedShape.height}
                onChange={(e) => updateShapePreview(selectedShape.id, { height: parseFloat(e.target.value) })}
                onPointerUp={(e) => updateShape(selectedShape.id, { height: parseFloat((e.target as HTMLInputElement).value) })}
                className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
            </div>
        )}

        {/* --- Rotation Controls --- */}
        <div className="space-y-4 pt-2 border-t border-slate-700">
            <div className="flex items-center gap-2">
                <RefreshCw size={12} className="text-slate-400" />
                <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider">旋轉設定</label>
            </div>

            {/* Y Rotation (Standard Direction for all objects) */}
            <div className="space-y-2">
                <div className="flex justify-between items-center">
                    <label className="text-[13px] text-slate-500 font-medium">方向 (水平旋轉)</label>
                    <input
                        type="number"
                        value={toDegrees(selectedShape.rotation[1])}
                        onChange={(e) => {
                            const newRot = [...selectedShape.rotation] as [number, number, number];
                            newRot[1] = toRadians(parseFloat(e.target.value) || 0);
                            updateShape(selectedShape.id, { rotation: newRot });
                        }}
                        className="w-20 bg-slate-900/80 border border-slate-600 rounded px-2 py-0.5 text-white text-base font-mono text-right outline-none focus:border-blue-500 transition-colors"
                    />
                </div>
                <input
                    type="range"
                    min="0"
                    max={Math.PI * 2}
                    step="0.05"
                    value={(selectedShape.rotation[1] + Math.PI * 2) % (Math.PI * 2)}
                    onChange={(e) => {
                        const newRot = [...selectedShape.rotation] as [number, number, number];
                        newRot[1] = parseFloat(e.target.value);
                        updateShapePreview(selectedShape.id, { rotation: newRot });
                    }}
                    onPointerUp={(e) => {
                        const newRot = [...selectedShape.rotation] as [number, number, number];
                        newRot[1] = parseFloat((e.target as HTMLInputElement).value);
                        updateShape(selectedShape.id, { rotation: newRot });
                    }}
                    className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
            </div>

            {/* Extra Rotation Axes for Text and Image (Allow 360 freedom) */}
            {(selectedShape.type === 'text' || selectedShape.type === 'image') && (
                <>
                    {/* X Rotation (Tilt) */}
                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                            <label className="text-[13px] text-slate-500 font-medium">傾斜 (X軸)</label>
                            <input
                                type="number"
                                value={toDegrees(selectedShape.rotation[0])}
                                onChange={(e) => {
                                    const newRot = [...selectedShape.rotation] as [number, number, number];
                                    newRot[0] = toRadians(parseFloat(e.target.value) || 0);
                                    updateShape(selectedShape.id, { rotation: newRot });
                                }}
                                className="w-20 bg-slate-900/80 border border-slate-600 rounded px-2 py-0.5 text-white text-base font-mono text-right outline-none focus:border-red-500"
                            />
                        </div>
                        <input
                            type="range"
                            min={-Math.PI}
                            max={Math.PI}
                            step="0.05"
                            value={selectedShape.rotation[0]}
                            onChange={(e) => {
                                const newRot = [...selectedShape.rotation] as [number, number, number];
                                newRot[0] = parseFloat(e.target.value);
                                updateShapePreview(selectedShape.id, { rotation: newRot });
                            }}
                            onPointerUp={(e) => {
                                const newRot = [...selectedShape.rotation] as [number, number, number];
                                newRot[0] = parseFloat((e.target as HTMLInputElement).value);
                                updateShape(selectedShape.id, { rotation: newRot });
                            }}
                            className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-red-500"
                        />
                        <div className="flex justify-between text-[12px] text-slate-600 px-1">
                            <span>-180°</span>
                            <span className="cursor-pointer hover:text-red-400" onClick={() => {
                                const newRot = [...selectedShape.rotation] as [number, number, number];
                                newRot[0] = -Math.PI/2;
                                updateShape(selectedShape.id, { rotation: newRot });
                            }}>{selectedShape.type === 'image' ? '平放' : '平躺'}</span>
                            <span className="cursor-pointer hover:text-red-400" onClick={() => {
                                const newRot = [...selectedShape.rotation] as [number, number, number];
                                newRot[0] = 0;
                                updateShape(selectedShape.id, { rotation: newRot });
                            }}>{selectedShape.type === 'image' ? '直立' : '直立'}</span>
                            <span>180°</span>
                        </div>
                    </div>

                    {/* Z Rotation (Spin/Roll) */}
                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                            <label className="text-[13px] text-slate-500 font-medium">自轉 (Z軸)</label>
                            <input
                                type="number"
                                value={toDegrees(selectedShape.rotation[2] || 0)}
                                onChange={(e) => {
                                    const newRot = [...selectedShape.rotation] as [number, number, number];
                                    newRot[2] = toRadians(parseFloat(e.target.value) || 0);
                                    updateShape(selectedShape.id, { rotation: newRot });
                                }}
                                className="w-20 bg-slate-900/80 border border-slate-600 rounded px-2 py-0.5 text-white text-base font-mono text-right outline-none focus:border-green-500"
                            />
                        </div>
                        <input
                            type="range"
                            min={-Math.PI}
                            max={Math.PI}
                            step="0.05"
                            value={selectedShape.rotation[2] || 0}
                            onChange={(e) => {
                                const newRot = [...selectedShape.rotation] as [number, number, number];
                                newRot[2] = parseFloat(e.target.value);
                                updateShapePreview(selectedShape.id, { rotation: newRot });
                            }}
                            onPointerUp={(e) => {
                                const newRot = [...selectedShape.rotation] as [number, number, number];
                                newRot[2] = parseFloat((e.target as HTMLInputElement).value);
                                updateShape(selectedShape.id, { rotation: newRot });
                            }}
                            className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-green-500"
                        />
                    </div>
                </>
            )}
        </div>

        {/* Color Picker — hidden for door */}
        {selectedShape.type !== 'door' && <div className="space-y-2 pt-2 border-t border-slate-700">
          <label className="text-[14px] text-slate-400 font-bold uppercase tracking-wider">材質顏色</label>
          <div className="grid grid-cols-5 gap-2">
            {PRESET_COLORS.map(color => (
              <button
                key={color}
                onClick={() => updateShape(selectedShape.id, { color })}
                className={`w-full aspect-square rounded-lg border transition-transform hover:scale-110 shadow-sm ${selectedShape.color === color ? 'border-white ring-1 ring-blue-500/50' : 'border-transparent'}`}
                style={{ backgroundColor: color }}
              />
            ))}
            <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-gradient-to-br from-white to-black border border-slate-600 hover:scale-110 transition-transform shadow-sm">
                <input
                    type="color"
                    className="absolute inset-0 w-[150%] h-[150%] -top-1/4 -left-1/4 cursor-pointer opacity-0"
                    value={selectedShape.color}
                    onChange={(e) => updateShape(selectedShape.id, { color: e.target.value })}
                />
            </div>
          </div>

          {/* Opacity controls for flat shapes */}
          {selectedShape.type === 'flat' && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-slate-400">顏色透明度</label>
                <span className="text-[13px] text-slate-300 font-mono">
                  {Math.round((selectedShape.opacity ?? 0.6) * 100)}%
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => updateShape(selectedShape.id, { opacity: 1.0 })}
                  className={`flex-1 py-1.5 rounded-lg text-[13px] font-medium border transition-colors ${(selectedShape.opacity ?? 0.6) >= 1.0 ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-600 text-slate-300 hover:border-slate-400'}`}
                >
                  不透明
                </button>
                <button
                  onClick={() => updateShape(selectedShape.id, { opacity: 0.6 })}
                  className={`flex-1 py-1.5 rounded-lg text-[13px] font-medium border transition-colors ${(selectedShape.opacity ?? 0.6) < 1.0 && (selectedShape.opacity ?? 0.6) > 0.3 ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-600 text-slate-300 hover:border-slate-400'}`}
                >
                  半透明
                </button>
                <button
                  onClick={() => updateShape(selectedShape.id, { opacity: 0.15 })}
                  className={`flex-1 py-1.5 rounded-lg text-[13px] font-medium border transition-colors ${(selectedShape.opacity ?? 0.6) <= 0.3 ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-600 text-slate-300 hover:border-slate-400'}`}
                >
                  透明
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={selectedShape.opacity ?? 0.6}
                onChange={(e) => updateShapePreview(selectedShape.id, { opacity: parseFloat(e.target.value) })}
                onPointerUp={(e) => updateShape(selectedShape.id, { opacity: parseFloat((e.target as HTMLInputElement).value) })}
                className="w-full accent-blue-500"
              />
            </div>
          )}
        </div>}
      </div>
    </div>
  );
};

export default PropertiesPanel;
