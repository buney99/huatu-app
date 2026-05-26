
import React, { useRef, useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import {
    FolderOpen,
    Save,
    Image as ImageIcon,
    FileDown,
    Undo2,
    Redo2,
    Layers,
    Box,
    Group,
    Ungroup,
    Maximize,
    Minimize,
    Crosshair,
    Upload,
    Ruler,
    X,
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

const Header: React.FC = () => {
    const {
        projectName,
        setProjectName,
        saveProject,
        openProject,
        exportImage,
        exportPDF,
        lastAutoSaved,
        unit,
        setUnit,
        undo,
        redo,
        canUndo,
        canRedo,
        isLayerPanelOpen,
        setLayerPanelOpen,
        showAxes,
        setShowAxes,
        setCurrentView,
        groupSelected,
        ungroupSelected,
        selectedIds,
        shapes,
        backgroundImage,
        setBackgroundImage,
        backgroundFilename,
        setBackgroundFilename,
        backgroundOpacity,
        setBackgroundOpacity,
        isCalibrating,
        setIsCalibrating,
    } = useApp();

    const fileInputRef = useRef<HTMLInputElement>(null);
    const bgFileInputRef = useRef<HTMLInputElement>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, []);

    const toggleFullscreen = () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch((err) => {
                console.error(`Error attempting to enable fullscreen: ${err.message}`);
                alert("無法進入全螢幕模式，可能是瀏覽器或預覽環境的限制。");
            });
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        }
    };

    const handleBgUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setBackgroundFilename(file.name);

        if (file.type === 'application/pdf') {
            try {
                const arrayBuffer = await file.arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                const page = await pdf.getPage(1);
                const viewport = page.getViewport({ scale: 2.0 });
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                if (context) {
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;
                    context.fillStyle = '#ffffff';
                    context.fillRect(0, 0, canvas.width, canvas.height);
                    await page.render({ canvasContext: context, viewport } as any).promise;
                    setBackgroundImage(canvas.toDataURL('image/png'));
                }
            } catch (error) {
                console.error('Error rendering PDF:', error);
                alert('無法讀取 PDF 檔案');
            }
        } else if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (e) => {
                if (e.target?.result) setBackgroundImage(e.target.result as string);
            };
            reader.readAsDataURL(file);
        } else {
            alert('請上傳圖片或 PDF 檔案');
        }

        if (bgFileInputRef.current) bgFileInputRef.current.value = '';
    };

    const handleBgRemove = () => {
        setBackgroundImage(null);
        setBackgroundFilename(null);
        setIsCalibrating(false);
    };

    const views = [
        { id: 'top',    label: '上', title: '上視 (Top)' },
        { id: 'front',  label: '前', title: '前視 (Front)' },
        { id: 'left',   label: '左', title: '左視 (Left)' },
        { id: 'right',  label: '右', title: '右視 (Right)' },
        { id: 'bottom', label: '底', title: '底視 (Bottom)' },
    ];

    const canGroup = selectedIds.length >= 2;
    const canUngroup = selectedIds.some(id => {
        const shape = shapes.find(s => s.id === id);
        return shape && shape.groupId;
    });

    const Sep = () => <div className="h-5 w-px bg-slate-200 mx-0.5 shrink-0" />;

    return (
        <div className="h-12 bg-white border-b border-slate-100 flex items-center justify-between px-3 z-40 shadow-sm shrink-0 gap-2 overflow-x-auto">

            {/* ── Left: Brand + History + Project Name ── */}
            <div className="flex items-center gap-2 shrink-0">
                <span className="text-sm font-bold text-slate-800 tracking-tight select-none">
                    Buney<span className="text-blue-500">畫圖</span>
                </span>
                <Sep />
                <button onClick={undo} disabled={!canUndo}
                    className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg disabled:opacity-30 transition-colors"
                    title="復原 (Ctrl+Z)">
                    <Undo2 size={16} />
                </button>
                <button onClick={redo} disabled={!canRedo}
                    className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg disabled:opacity-30 transition-colors"
                    title="重做 (Ctrl+Y)">
                    <Redo2 size={16} />
                </button>
                <Sep />
                <input
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    className="py-0.5 bg-transparent border-b border-slate-200 focus:border-blue-400 text-sm font-medium text-slate-700 outline-none w-28 transition-colors"
                    placeholder="未命名專案"
                />
            </div>

            {/* ── Center: View + Group ── */}
            <div className="flex items-center gap-2 shrink-0">
                <div className="flex items-center gap-0.5 bg-slate-50 px-1.5 py-1 rounded-lg">
                    <Box size={13} className="text-slate-400 mr-1" />
                    {views.map(view => (
                        <button
                            key={view.id}
                            onClick={() => setCurrentView(view.id)}
                            title={view.title}
                            className="px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white hover:text-blue-600 hover:shadow-sm rounded transition-all"
                        >
                            {view.label}
                        </button>
                    ))}
                </div>

                <div className="flex items-center gap-0.5 bg-slate-50 px-1 py-1 rounded-lg">
                    <button
                        onClick={groupSelected} disabled={!canGroup}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white hover:text-blue-600 hover:shadow-sm rounded transition-all disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:shadow-none"
                        title="群組 (Ctrl+G)"
                    >
                        <Group size={14} />
                        <span>群組</span>
                    </button>
                    <button
                        onClick={ungroupSelected} disabled={!canUngroup}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white hover:text-blue-600 hover:shadow-sm rounded transition-all disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:shadow-none"
                        title="解除群組 (Ctrl+Shift+G)"
                    >
                        <Ungroup size={14} />
                        <span>解群</span>
                    </button>
                </div>
            </div>

            {/* ── Right: Actions ── */}
            <div className="flex items-center gap-1 shrink-0">

                {/* Background Image */}
                <input type="file" ref={bgFileInputRef} onChange={handleBgUpload} accept="image/*,.pdf" className="hidden" />
                <button
                    onClick={() => bgFileInputRef.current?.click()}
                    title={backgroundImage ? `底圖：${backgroundFilename}\n點擊換底圖` : '上傳底圖 (圖片 / PDF)'}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border transition-colors text-sm font-medium
                        ${backgroundImage
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                >
                    <Upload size={14} />
                    <span className="text-xs">{backgroundImage ? '換底圖' : '底圖'}</span>
                </button>

                {backgroundImage && (
                    <>
                        <div className="flex items-center gap-1">
                            <span className="text-xs text-slate-400">透明</span>
                            <input
                                type="range" min="0" max="100"
                                value={backgroundOpacity}
                                onChange={(e) => setBackgroundOpacity(Number(e.target.value))}
                                className="w-16 accent-blue-600"
                                title={`底圖透明度 ${backgroundOpacity}%`}
                            />
                            <span className="text-xs text-slate-400 w-6 tabular-nums">{backgroundOpacity}%</span>
                        </div>
                        <button
                            onClick={() => setIsCalibrating(!isCalibrating)}
                            title={isCalibrating ? '校正中 (請在底圖上畫線)' : '校正比例'}
                            className={`p-1.5 rounded-lg border transition-all
                                ${isCalibrating
                                    ? 'bg-blue-50 border-blue-200 text-blue-600'
                                    : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}
                        >
                            <Ruler size={14} />
                        </button>
                        <button
                            onClick={handleBgRemove} title="移除底圖"
                            className="p-1.5 bg-white hover:bg-red-50 text-slate-400 hover:text-red-500 rounded-lg border border-slate-200 hover:border-red-200 transition-colors"
                        >
                            <X size={14} />
                        </button>
                    </>
                )}

                <Sep />

                <button
                    onClick={() => setShowAxes(!showAxes)} title="顯示/隱藏 XYZ 軸線"
                    className={`p-1.5 rounded-lg border transition-all
                        ${showAxes ? 'bg-blue-50 border-blue-200 text-blue-600' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}
                >
                    <Crosshair size={15} />
                </button>

                <button
                    onClick={() => setLayerPanelOpen(!isLayerPanelOpen)} title="圖層管理"
                    className={`p-1.5 rounded-lg border transition-all
                        ${isLayerPanelOpen ? 'bg-blue-50 border-blue-200 text-blue-600' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}
                >
                    <Layers size={15} />
                </button>

                <Sep />

                <input type="file" ref={fileInputRef} onChange={(e) => e.target.files && openProject(e.target.files[0])} accept=".json" className="hidden" />
                <button
                    onClick={() => fileInputRef.current?.click()}
                    title="開啟專案"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-slate-600 hover:bg-slate-100 rounded-lg border border-slate-200 transition-colors text-sm font-medium"
                >
                    <FolderOpen size={15} />
                    <span className="text-xs">開啟</span>
                </button>

                <button
                    onClick={saveProject} title="儲存專案"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-slate-600 hover:bg-slate-100 rounded-lg border border-slate-200 transition-colors text-sm font-medium"
                >
                    <Save size={15} />
                    <span className="text-xs">儲存</span>
                </button>

                <Sep />

                <button
                    onClick={exportImage} title="匯出圖片"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-sm transition-colors text-sm font-medium"
                >
                    <ImageIcon size={15} />
                    <span className="text-xs">圖片</span>
                </button>

                <button
                    onClick={exportPDF} title="匯出 PDF"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-700 hover:bg-slate-800 text-white rounded-lg shadow-sm transition-colors text-sm font-medium"
                >
                    <FileDown size={15} />
                    <span className="text-xs">PDF</span>
                </button>

                <button
                    onClick={toggleFullscreen}
                    title={isFullscreen ? '退出全螢幕' : '全螢幕'}
                    className="p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 rounded-lg border border-slate-200 transition-colors"
                >
                    {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
                </button>

                <Sep />

                {/* Auto-save status */}
                {lastAutoSaved && (
                    <span
                        className="text-[10px] text-slate-400 hidden lg:block whitespace-nowrap select-none"
                        title={`上次自動儲存：${lastAutoSaved.toLocaleTimeString()}`}
                    >
                        ✓ {lastAutoSaved.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                )}

                {/* Unit Toggle */}
                <div className="flex bg-slate-100 rounded-lg p-0.5">
                    <button
                        onClick={() => setUnit('m')} title="公尺"
                        className={`px-2 py-0.5 text-xs rounded font-bold transition-colors ${unit === 'm' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                        m
                    </button>
                    <button
                        onClick={() => setUnit('cm')} title="公分"
                        className={`px-2 py-0.5 text-xs rounded font-bold transition-colors ${unit === 'cm' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                        cm
                    </button>
                </div>
            </div>
        </div>
    );
};

export default Header;
