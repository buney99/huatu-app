import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';

const InfoBar: React.FC = () => {
  const { subscribeMeasurement } = useApp();
  const [text, setText] = useState('');

  useEffect(() => {
    const unsubscribe = subscribeMeasurement((val) => {
      setText(val);
    });
    return unsubscribe;
  }, [subscribeMeasurement]);

  if (!text) return null;

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
      <div translate="no" className="bg-slate-800/90 text-white px-4 py-2 rounded-lg border border-slate-600 shadow-xl backdrop-blur-sm font-mono text-sm flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
        {text}
      </div>
    </div>
  );
};

export default InfoBar;