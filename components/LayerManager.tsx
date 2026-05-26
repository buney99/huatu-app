
import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Eye, EyeOff, Plus, Trash2, Layers, X, GripVertical, CheckCircle2, Circle } from 'lucide-react';

const LayerManager: React.FC = () => {
    const { 
        layers, 
        activeLayerId, 
        setActiveLayerId, 
        addLayer, 
        removeLayer, 
        toggleLayerVisibility, 
        updateLayerName,
        isLayerPanelOpen,
        setLayerPanelOpen
    } = useApp();

    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');

    if (!isLayerPanelOpen) return null;

    const handleStartEdit = (id: string, currentName: string) => {
        setEditingId(id);
        setEditName(currentName);
    };

    const handleFinishEdit = (id: string) => {
        if (editName.trim()) {
            updateLayerName(id, editName);
        }
        setEditingId(null);
    };

    return (
        <div className="absolute top-20 left-20 w-80 bg-white/95 backdrop-blur-sm rounded-xl shadow-2xl border border-slate-200 overflow-hidden z-30 animate-in fade-in slide-in-from-left-4 flex flex-col font-sans pointer-events-auto">
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-slate-100 bg-slate-50">
                <div className="flex items-center gap-2 text-slate-700 font-semibold">
                    <Layers size={18} className="text-blue-600" />
                    <span>圖層管理</span>
                </div>
                <div className="flex items-center gap-1">
                    <button 
                        onClick={() => addLayer(`新圖層 ${layers.length + 1}`)}
                        className="p-1.5 hover:bg-blue-100 text-blue-600 rounded transition-colors"
                        title="新增圖層"
                    >
                        <Plus size={18} />
                    </button>
                    <button 
                        onClick={() => setLayerPanelOpen(false)}
                        className="p-1.5 hover:bg-slate-200 text-slate-500 rounded transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto max-h-[60vh] p-2 space-y-1">
                {layers.map((layer) => (
                    <div 
                        key={layer.id} 
                        className={`flex items-center gap-2 p-2 rounded-lg group border transition-all duration-200
                            ${activeLayerId === layer.id ? 'bg-blue-50 border-blue-200' : 'bg-white border-transparent hover:bg-slate-50 hover:border-slate-200'}
                        `}
                    >
                        {/* Active Toggle */}
                        <button 
                            onClick={() => setActiveLayerId(layer.id)}
                            className="text-slate-400 hover:text-blue-500"
                            title="設為當前圖層"
                        >
                            {activeLayerId === layer.id ? (
                                <CheckCircle2 size={18} className="text-blue-600 fill-blue-100" />
                            ) : (
                                <Circle size={18} />
                            )}
                        </button>

                        {/* Name */}
                        <div className="flex-1 text-sm text-slate-700" onDoubleClick={() => handleStartEdit(layer.id, layer.name)}>
                            {editingId === layer.id ? (
                                <input 
                                    autoFocus
                                    className="w-full px-1 py-0.5 border border-blue-400 rounded outline-none text-sm"
                                    value={editName}
                                    onChange={e => setEditName(e.target.value)}
                                    onBlur={() => handleFinishEdit(layer.id)}
                                    onKeyDown={e => e.key === 'Enter' && handleFinishEdit(layer.id)}
                                />
                            ) : (
                                <span className={activeLayerId === layer.id ? 'font-medium' : ''}>
                                    {layer.name}
                                    {activeLayerId === layer.id && <span className="ml-2 text-[10px] text-blue-500 font-bold bg-blue-100 px-1.5 py-0.5 rounded-full">當前</span>}
                                </span>
                            )}
                        </div>

                        {/* Visibility */}
                        <button 
                            onClick={() => toggleLayerVisibility(layer.id)}
                            title={layer.visible ? "隱藏圖層" : "顯示圖層"}
                            className={`p-1.5 rounded transition-colors ${layer.visible ? 'text-slate-600 hover:bg-slate-200' : 'text-slate-300 hover:text-slate-500 hover:bg-slate-100'}`}
                        >
                            {layer.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                        </button>

                        {/* Delete (only if not active and not only one) */}
                        <button 
                            onClick={() => removeLayer(layer.id)}
                            disabled={layers.length <= 1 || activeLayerId === layer.id}
                            title="刪除圖層"
                            className={`p-1.5 rounded transition-colors ${layers.length <= 1 || activeLayerId === layer.id ? 'opacity-0' : 'opacity-0 group-hover:opacity-100 text-red-400 hover:bg-red-50'}`}
                        >
                            <Trash2 size={16} />
                        </button>
                    </div>
                ))}
            </div>
            
            <div className="bg-slate-50 p-2 pl-3 border-t border-slate-100">
                <span className="text-[10px] text-slate-400">雙擊名稱可重新命名 • 點擊圓圈切換當前圖層</span>
            </div>
        </div>
    );
};

export default LayerManager;
