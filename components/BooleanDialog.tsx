
import React from 'react';
import { useApp } from '../context/AppContext';
import { Scissors, BoxSelect, XCircle, Box } from 'lucide-react';

const BooleanDialog: React.FC = () => {
    const { booleanModal, confirmBooleanOperation, cancelBooleanOperation } = useApp();
    const { open, base, cutters } = booleanModal;

    if (!open || !base) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            {/* Backdrop */}
            <div 
                className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
                onClick={cancelBooleanOperation}
            />

            {/* Modal Content */}
            <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200 border border-slate-200">
                {/* Header */}
                <div className="bg-slate-50 border-b border-slate-100 p-4 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-slate-800 font-bold text-lg">
                        <Scissors className="text-blue-500" />
                        <h3>挖孔運算設定</h3>
                    </div>
                    <button 
                        onClick={cancelBooleanOperation}
                        className="text-slate-400 hover:text-slate-600 transition-colors"
                    >
                        <XCircle size={24} />
                    </button>
                </div>

                {/* Body */}
                <div className="p-6 space-y-6">
                    <div className="space-y-2">
                        <p className="text-slate-600 text-sm">即將執行布林運算，請確認角色：</p>
                        <div className="flex gap-2 text-sm">
                            <div className="flex-1 bg-blue-50 border border-blue-100 p-3 rounded-lg flex items-center gap-2">
                                <Box className="text-blue-500" size={16} />
                                <div>
                                    <div className="font-bold text-blue-700">主體 (被挖)</div>
                                    <div className="text-blue-600/80 truncate">{base.name}</div>
                                </div>
                            </div>
                            <div className="flex-1 bg-red-50 border border-red-100 p-3 rounded-lg flex items-center gap-2">
                                <BoxSelect className="text-red-500" size={16} />
                                <div>
                                    <div className="font-bold text-red-700">孔洞 (刀具)</div>
                                    <div className="text-red-600/80">{cutters.length} 個物件</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-3">
                         <p className="text-slate-600 text-sm font-medium">請選擇挖孔模式：</p>
                         
                         <button
                            onClick={() => confirmBooleanOperation(true)}
                            className="w-full flex items-center gap-4 p-4 border-2 border-slate-100 rounded-xl hover:border-blue-500 hover:bg-blue-50 transition-all group text-left"
                         >
                            <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                                <div className="w-5 h-3 border-b-2 border-l-2 border-r-2 border-current rounded-b-sm"></div>
                            </div>
                            <div>
                                <div className="font-bold text-slate-800 group-hover:text-blue-700">保留底部 (製作容器)</div>
                                <div className="text-xs text-slate-500 mt-1">
                                    底部會保留一層薄板，適合製作杯子、盒子或凹槽。
                                </div>
                            </div>
                         </button>

                         <button
                            onClick={() => confirmBooleanOperation(false)}
                            className="w-full flex items-center gap-4 p-4 border-2 border-slate-100 rounded-xl hover:border-red-500 hover:bg-red-50 transition-all group text-left"
                         >
                            <div className="w-10 h-10 rounded-full bg-red-100 text-red-600 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                                <div className="w-5 h-5 border-2 border-current rounded-full"></div>
                            </div>
                            <div>
                                <div className="font-bold text-slate-800 group-hover:text-red-700">完全挖空 (穿透)</div>
                                <div className="text-xs text-slate-500 mt-1">
                                    直接打通到底，形成完全穿透的孔洞。
                                </div>
                            </div>
                         </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default BooleanDialog;
