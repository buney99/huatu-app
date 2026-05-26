
import React from 'react';
import { AppProvider } from './context/AppContext';
import Viewport from './components/Viewport';
import Toolbar from './components/Toolbar';
import PropertiesPanel from './components/PropertiesPanel';
import InfoBar from './components/InfoBar';
import Header from './components/Header';
import LayerManager from './components/LayerManager';
import BooleanDialog from './components/BooleanDialog';

const App: React.FC = () => {
  return (
    <AppProvider>
      <div className="w-full h-screen relative flex flex-col overflow-hidden bg-slate-50 text-slate-900 font-sans">
        {/* Header - static relative position */}
        <Header />
        
        {/* Main Content Area */}
        <div className="flex-1 relative overflow-hidden">
            <Viewport />
            
            {/* Left Side Controls (Floating) */}
            <div className="absolute top-4 left-4 z-30 flex flex-col gap-4 pointer-events-none">
               <Toolbar />
            </div>
            
            {/* Layer Panel (Floating, managed by state) */}
            <LayerManager />

            {/* Modal Dialogs */}
            <BooleanDialog />

            {/* Right Side Controls (Floating) */}
            <PropertiesPanel />
            
            {/* Bottom Controls */}
            <InfoBar />
        </div>
      </div>
    </AppProvider>
  );
};

export default App;
