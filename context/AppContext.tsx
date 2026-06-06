
import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { IShape, ToolType, IPoint, TransformMode, ILayer, IGuideLine } from '../types';
import { DEFAULT_HEIGHT } from '../constants';
import * as THREE from 'three';
import { blockErasedPolygon } from '../utils/polygonDetection';

type UnitType = 'm' | 'cm';

interface AppContextType {
  // Project Info
  projectName: string;
  setProjectName: (name: string) => void;

  // Shapes
  shapes: IShape[];
  addShape: (shape: IShape) => void;
  updateShape: (id: string, updates: Partial<IShape>) => void;
  updateShapePreview: (id: string, updates: Partial<IShape>) => void;
  updateShapes: (updates: { id: string; changes: Partial<IShape> }[]) => void;
  removeShape: (id: string) => void;
  decomposeFlat: (id: string) => void;
  removeSelected: () => void;
  replaceShapes: (idsToRemove: string[], newShapes: IShape[]) => void;
  copySelected: () => void;
  groupSelected: () => void;
  ungroupSelected: () => void;
  subtractSelected: () => void; // Initiates the process
  
  // Boolean Operation Modal State
  booleanModal: { open: boolean; base: IShape | null; cutters: IShape[] };
  confirmBooleanOperation: (isContainer: boolean) => void;
  cancelBooleanOperation: () => void;

  // Guide Lines
  guideLines: IGuideLine[];
  addGuideLine: (line: IGuideLine) => void;
  removeGuideLine: (id: string) => void;
  clearGuideLines: () => void;

  // Layers
  layers: ILayer[];
  activeLayerId: string;
  setActiveLayerId: (id: string) => void;
  addLayer: (name: string) => void;
  removeLayer: (id: string) => void;
  toggleLayerVisibility: (id: string) => void;
  updateLayerName: (id: string, name: string) => void;
  
  // Selection
  selectedIds: string[];
  selectShape: (id: string, multi?: boolean) => void;
  selectShapes: (ids: string[]) => void;
  deselectAll: () => void;
  selectedId: string | null; 
  setSelectedId: (id: string | null) => void;

  // Tools & State
  tool: ToolType;
  setTool: (tool: ToolType) => void;
  transformMode: TransformMode;
  setTransformMode: (mode: TransformMode) => void;
  clearScene: () => void;
  unit: UnitType;
  setUnit: (unit: UnitType) => void;
  formatValue: (val: number) => string;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  wallThickness: number;
  setWallThickness: (val: number) => void;
  
  // View Control
  currentView: string | null;
  setCurrentView: (view: string | null) => void;

  // File I/O
  saveProject: () => void;
  openProject: (file: File) => void;
  exportImage: () => void;
  exportPDF: () => void;
  setExportOverlay: (fn: ((canvas: HTMLCanvasElement) => HTMLCanvasElement) | null) => void;
  lastAutoSaved: Date | null;

  // UI Toggles
  isLayerPanelOpen: boolean;
  setLayerPanelOpen: (open: boolean) => void;
  showAxes: boolean;
  setShowAxes: (show: boolean) => void;

  // Background Image
  backgroundImage: string | null;
  setBackgroundImage: (url: string | null) => void;
  backgroundFilename: string | null;
  setBackgroundFilename: (name: string | null) => void;
  backgroundOpacity: number;
  setBackgroundOpacity: (opacity: number) => void;
  backgroundScale: number;
  setBackgroundScale: (scale: number) => void;
  backgroundPosition: [number, number, number];
  setBackgroundPosition: (pos: [number, number, number]) => void;
  isCalibrating: boolean;
  setIsCalibrating: (calibrating: boolean) => void;

  // Measurement
  setMeasurement: (val: string) => void;
  subscribeMeasurement: (cb: (val: string) => void) => () => void;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

const DEFAULT_LAYERS: ILayer[] = [
    { id: 'layer-structure', name: '結構 (柱/樑/牆)', visible: true, locked: false },
    { id: 'layer-partition', name: '輕隔間', visible: true, locked: false },
    { id: 'layer-furniture', name: '家具/設備', visible: true, locked: false },
    { id: 'layer-annotation', name: '標註/文字', visible: true, locked: false },
];

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // History State
  const [history, setHistory] = useState<{shapes: IShape[], layers: ILayer[], guideLines: IGuideLine[]}[]>([{ shapes: [], layers: DEFAULT_LAYERS, guideLines: [] }]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const [projectName, setProjectName] = useState('未命名專案');
  const [shapes, setShapes] = useState<IShape[]>([]);
  const [guideLines, setGuideLines] = useState<IGuideLine[]>([]);
  const [layers, setLayers] = useState<ILayer[]>(DEFAULT_LAYERS);
  const [activeLayerId, setActiveLayerId] = useState<string>('layer-structure');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  
  const [tool, setTool] = useState<ToolType>(ToolType.SELECT);
  const [transformMode, setTransformMode] = useState<TransformMode>('translate');
  const [unit, setUnit] = useState<UnitType>('cm');
  const [wallThickness, setWallThickness] = useState<number>(0.01);
  const [isLayerPanelOpen, setLayerPanelOpen] = useState(false);
  const [showAxes, setShowAxes] = useState(true);
  
  const [currentView, setCurrentView] = useState<string | null>(null);

  // Background Image State
  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);
  const [backgroundFilename, setBackgroundFilename] = useState<string | null>(null);
  const [backgroundOpacity, setBackgroundOpacity] = useState<number>(95);
  const [backgroundScale, setBackgroundScale] = useState<number>(1);
  const [backgroundPosition, setBackgroundPosition] = useState<[number, number, number]>([0, 0, 0]);
  const [isCalibrating, setIsCalibrating] = useState<boolean>(false);
  const [lastAutoSaved, setLastAutoSaved] = useState<Date | null>(null);

  // Boolean Modal State
  const [booleanModal, setBooleanModal] = useState<{ open: boolean; base: IShape | null; cutters: IShape[] }>({
      open: false,
      base: null,
      cutters: []
  });

  // Measurement Listeners
  const measurementListeners = useRef<Set<(val: string) => void>>(new Set());
  
  const setMeasurement = useCallback((val: string) => {
    measurementListeners.current.forEach(cb => cb(val));
  }, []);

  const subscribeMeasurement = useCallback((cb: (val: string) => void) => {
    measurementListeners.current.add(cb);
    return () => {
        measurementListeners.current.delete(cb);
    };
  }, []);

  const stateRef = useRef({ shapes, layers, guideLines, history, historyIndex, activeLayerId, selectedIds, projectName, backgroundImage, backgroundFilename, backgroundOpacity, backgroundScale, backgroundPosition });
  useEffect(() => {
    stateRef.current = { shapes, layers, guideLines, history, historyIndex, activeLayerId, selectedIds, projectName, backgroundImage, backgroundFilename, backgroundOpacity, backgroundScale, backgroundPosition };
  }, [shapes, layers, guideLines, history, historyIndex, activeLayerId, selectedIds, projectName, backgroundImage, backgroundFilename, backgroundOpacity, backgroundScale, backgroundPosition]);

  // Auto-restore: on first load, try to recover the last working session from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem('buney_autosave');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data?.shapes && Array.isArray(data.shapes) && data?.layers) {
        const migratedShapes = data.shapes.map((s: any) => ({
          ...s,
          layerId: s.layerId || DEFAULT_LAYERS[0].id,
          rotation: typeof s.rotation === 'number' ? [0, s.rotation, 0] : s.rotation || [0, 0, 0],
        }));
        setProjectName(data.projectName || '未命名專案');
        setShapes(migratedShapes);
        setLayers(data.layers);
        if (data.activeLayerId) setActiveLayerId(data.activeLayerId);
        setGuideLines(data.guideLines || []);
        setHistory([{ shapes: migratedShapes, layers: data.layers, guideLines: data.guideLines || [] }]);
        setHistoryIndex(0);
        setSelectedIds([]);
      }
    } catch (e) {
      console.warn('自動存檔讀取失敗', e);
    }
    // Restore background image (stored separately due to size)
    try {
      const rawBg = localStorage.getItem('buney_autosave_bg');
      if (!rawBg) return;
      const bg = JSON.parse(rawBg);
      if (bg?.backgroundImage) setBackgroundImage(bg.backgroundImage);
      if (bg?.backgroundFilename) setBackgroundFilename(bg.backgroundFilename);
      if (typeof bg?.backgroundOpacity === 'number') setBackgroundOpacity(bg.backgroundOpacity);
      if (typeof bg?.backgroundScale === 'number') setBackgroundScale(bg.backgroundScale);
      if (Array.isArray(bg?.backgroundPosition)) setBackgroundPosition(bg.backgroundPosition);
    } catch (e) {
      console.warn('底圖自動存檔讀取失敗', e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save: debounced 2.5s after any content change
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const { shapes: s, layers: l, activeLayerId: al, guideLines: gl } = stateRef.current;
        const data = {
          version: '1.0.0',
          projectName,
          shapes: s,
          layers: l,
          activeLayerId: al,
          guideLines: gl,
          savedAt: new Date().toISOString(),
        };
        localStorage.setItem('buney_autosave', JSON.stringify(data));
        setLastAutoSaved(new Date());
      } catch (e) {
        console.warn('自動存檔失敗', e);
      }
    }, 2500);
    return () => clearTimeout(timer);
  }, [shapes, layers, guideLines, projectName]);

  // Auto-save background image separately (base64 can be large; isolated so quota errors don't break main save)
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (backgroundImage) {
          const bgData = {
            backgroundImage,
            backgroundFilename,
            backgroundOpacity,
            backgroundScale,
            backgroundPosition,
          };
          localStorage.setItem('buney_autosave_bg', JSON.stringify(bgData));
        } else {
          localStorage.removeItem('buney_autosave_bg');
        }
      } catch (e) {
        console.warn('底圖自動存檔失敗（可能超過儲存限制）', e);
      }
    }, 2500);
    return () => clearTimeout(timer);
  }, [backgroundImage, backgroundFilename, backgroundOpacity, backgroundScale, backgroundPosition]);

  // Internal helper to commit changes to history
  const _commitState = useCallback((newShapes: IShape[], newLayers: ILayer[], newGuideLines: IGuideLine[]) => {
    const { history, historyIndex } = stateRef.current;
    let newHistory = history.slice(0, historyIndex + 1);
    newHistory.push({ shapes: newShapes, layers: newLayers, guideLines: newGuideLines });
    if (newHistory.length > 50) {
        newHistory = newHistory.slice(newHistory.length - 50);
    }
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    setShapes(newShapes);
    setLayers(newLayers);
    setGuideLines(newGuideLines);
    stateRef.current = { ...stateRef.current, shapes: newShapes, layers: newLayers, guideLines: newGuideLines, history: newHistory, historyIndex: newHistory.length - 1 };
  }, []);

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setShapes(history[newIndex].shapes);
      setLayers(history[newIndex].layers);
      setGuideLines(history[newIndex].guideLines);
      setSelectedIds([]);
      stateRef.current = { 
          ...stateRef.current, 
          shapes: history[newIndex].shapes, 
          layers: history[newIndex].layers, 
          guideLines: history[newIndex].guideLines, 
          historyIndex: newIndex,
          selectedIds: []
      };
    }
  }, [history, historyIndex]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      setShapes(history[newIndex].shapes);
      setLayers(history[newIndex].layers);
      setGuideLines(history[newIndex].guideLines);
      setSelectedIds([]);
      stateRef.current = { 
          ...stateRef.current, 
          shapes: history[newIndex].shapes, 
          layers: history[newIndex].layers, 
          guideLines: history[newIndex].guideLines, 
          historyIndex: newIndex,
          selectedIds: []
      };
    }
  }, [history, historyIndex]);

  // --- Layer Logic ---
  const addLayer = useCallback((name: string) => {
      const { layers, shapes, guideLines } = stateRef.current;
      const newLayer: ILayer = {
          id: `layer-${Date.now()}-${Math.random()}`,
          name: name || '新圖層',
          visible: true,
          locked: false
      };
      const newLayers = [...layers, newLayer];
      _commitState(shapes, newLayers, guideLines);
      setActiveLayerId(newLayer.id);
  }, [_commitState]);

  const removeLayer = useCallback((id: string) => {
      const { layers, shapes, guideLines, activeLayerId } = stateRef.current;
      if (layers.length <= 1) return; // Prevent deleting last layer
      const newLayers = layers.filter(l => l.id !== id);
      // Move shapes from deleted layer to the first available layer
      const fallbackLayerId = newLayers[0].id;
      const newShapes = shapes.map(s => s.layerId === id ? { ...s, layerId: fallbackLayerId } : s);
      
      if (activeLayerId === id) setActiveLayerId(fallbackLayerId);
      
      _commitState(newShapes, newLayers, guideLines);
  }, [_commitState]);

  const toggleLayerVisibility = useCallback((id: string) => {
      const { layers, shapes, guideLines } = stateRef.current;
      const newLayers = layers.map(l => l.id === id ? { ...l, visible: !l.visible } : l);
      _commitState(shapes, newLayers, guideLines);
  }, [_commitState]);

  const updateLayerName = useCallback((id: string, name: string) => {
      const { layers, shapes, guideLines } = stateRef.current;
      const newLayers = layers.map(l => l.id === id ? { ...l, name } : l);
      _commitState(shapes, newLayers, guideLines);
  }, [_commitState]);


  // --- Shape Logic ---

  const addShape = useCallback((shape: IShape) => {
    const { shapes, layers, guideLines, activeLayerId } = stateRef.current;
    // Ensure shape has a layer. If not provided, use active.
    const finalShape = { ...shape, layerId: shape.layerId || activeLayerId };
    const newShapes = [...shapes, finalShape];
    _commitState(newShapes, layers, guideLines);
    setSelectedIds([shape.id]);
  }, [_commitState]);

  const updateShape = useCallback((id: string, updates: Partial<IShape>) => {
    const { shapes, layers, guideLines } = stateRef.current;
    const newShapes = shapes.map(s => s.id === id ? { ...s, ...updates } : s);
    _commitState(newShapes, layers, guideLines);
  }, [_commitState]);

  // Preview update: updates shapes visually without writing to undo history.
  // Use this for continuous interactions (slider drag, live input) and call
  // updateShape once on release to commit a single history entry.
  const updateShapePreview = useCallback((id: string, updates: Partial<IShape>) => {
    const { shapes } = stateRef.current;
    const newShapes = shapes.map(s => s.id === id ? { ...s, ...updates } : s);
    setShapes(newShapes);
    stateRef.current = { ...stateRef.current, shapes: newShapes };
  }, []);

  const updateShapes = useCallback((updates: { id: string; changes: Partial<IShape> }[]) => {
    const { shapes, layers, guideLines } = stateRef.current;
    const newShapes = shapes.map(s => {
      const update = updates.find(u => u.id === s.id);
      if (update) {
          const newShape = { ...s, ...update.changes };
          // Explicitly remove groupId if it is set to undefined
          if (update.changes.groupId === undefined && 'groupId' in update.changes) {
              delete newShape.groupId;
          }
          return newShape;
      }
      return s;
    });
    _commitState(newShapes, layers, guideLines);
  }, [_commitState]);

  const removeShape = useCallback((id: string) => {
    const { shapes, layers, guideLines, selectedIds } = stateRef.current;
    // Find all children recursively
    let idsToRemove = [id];
    let added = true;
    while (added) {
        added = false;
        for (const s of shapes) {
            if (s.parentId && idsToRemove.includes(s.parentId) && !idsToRemove.includes(s.id)) {
                idsToRemove.push(s.id);
                added = true;
            }
        }
    }
    
    const newShapes = shapes.filter(s => !idsToRemove.includes(s.id));
    _commitState(newShapes, layers, guideLines);
    if (selectedIds.some(sid => idsToRemove.includes(sid))) {
        setSelectedIds(prev => prev.filter(pid => !idsToRemove.includes(pid)));
    }
  }, [_commitState]);

  const decomposeFlat = useCallback((id: string) => {
    const { shapes, layers, guideLines } = stateRef.current;
    const shape = shapes.find(s => s.id === id);
    if (!shape || shape.type !== 'flat') return;

    // 把 local points 轉成 world 座標（考慮 rotation）
    const euler = new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2]);
    const worldPoints = shape.points.map(p => {
        const v = new THREE.Vector3(p.x, p.y, p.z);
        v.applyEuler(euler);
        v.x += shape.position[0];
        v.y += shape.position[1];
        v.z += shape.position[2];
        return v;
    });

    // 每條邊變成一個獨立 line 形狀（跳過場景中已存在的邊，避免重複）
    const n = worldPoints.length;
    const EDGE_TOL = 0.05;
    const lineShapes: IShape[] = [];
    for (let i = 0; i < n; i++) {
        const startPt = worldPoints[i];
        const endPt = worldPoints[(i + 1) % n];
        const alreadyExists = shapes.some(s => {
            if (s.type !== 'line' || s.id === id) return false;
            const p0 = new THREE.Vector3(s.position[0], s.position[1], s.position[2]);
            const p1 = p0.clone().add(new THREE.Vector3(s.points[1].x, s.points[1].y, s.points[1].z));
            return (p0.distanceTo(startPt) < EDGE_TOL && p1.distanceTo(endPt) < EDGE_TOL) ||
                   (p0.distanceTo(endPt) < EDGE_TOL && p1.distanceTo(startPt) < EDGE_TOL);
        });
        if (!alreadyExists) {
            lineShapes.push({
                id: `line-decomp-${Date.now()}-${i}-${Math.random()}`,
                layerId: shape.layerId,
                type: 'line' as const,
                name: '直線',
                points: [
                    { x: 0, y: 0, z: 0 },
                    { x: endPt.x - startPt.x, y: endPt.y - startPt.y, z: endPt.z - startPt.z }
                ],
                position: [startPt.x, startPt.y, startPt.z] as [number, number, number],
                rotation: [0, 0, 0] as [number, number, number],
                scale: [1, 1, 1] as [number, number, number],
                height: 0,
                color: '#000000',
                lineWidth: shape.lineWidth ?? 0,
            });
        }
    }

    // 移除 flat，加入缺少的邊框 line
    const newShapes = shapes.filter(s => s.id !== id).concat(lineShapes);
    _commitState(newShapes, layers, guideLines);
    setSelectedIds([]);
  }, [_commitState]);

  const removeSelected = useCallback(() => {
    const { shapes, layers, guideLines, selectedIds } = stateRef.current;
    if (selectedIds.length === 0) return;
    
    // Find all children recursively
    let idsToRemove = [...selectedIds];
    let added = true;
    while (added) {
        added = false;
        for (const s of shapes) {
            if (s.parentId && idsToRemove.includes(s.parentId) && !idsToRemove.includes(s.id)) {
                idsToRemove.push(s.id);
                added = true;
            }
        }
    }
    
    // Block polygon re-detection for any flat shapes being removed
    shapes.filter(s => idsToRemove.includes(s.id) && s.type === 'flat').forEach(blockErasedPolygon);

    const newShapes = shapes.filter(s => !idsToRemove.includes(s.id));
    _commitState(newShapes, layers, guideLines);
    setSelectedIds([]);
  }, [_commitState]);

  const replaceShapes = useCallback((idsToRemove: string[], newShapes: IShape[]) => {
    const { shapes, layers, guideLines, activeLayerId } = stateRef.current;
    const filteredCurrent = shapes.filter(s => !idsToRemove.includes(s.id));
    // Assign active layer to new shapes if they don't have one
    const labeledNewShapes = newShapes.map(s => ({ ...s, layerId: s.layerId || activeLayerId }));
    const combined = [...filteredCurrent, ...labeledNewShapes];
    _commitState(combined, layers, guideLines);
    if (newShapes.length === 1) setSelectedIds([newShapes[0].id]);
    else setSelectedIds([]);
  }, [_commitState]);

  const copySelected = useCallback(() => {
    const { shapes, layers, guideLines, selectedIds } = stateRef.current;
    if (selectedIds.length === 0) return;
    
    // Find all children recursively
    let idsToCopy = [...selectedIds];
    let added = true;
    while (added) {
        added = false;
        for (const s of shapes) {
            if (s.parentId && idsToCopy.includes(s.parentId) && !idsToCopy.includes(s.id)) {
                idsToCopy.push(s.id);
                added = true;
            }
        }
    }
    
    const groupMapping: Record<string, string> = {};
    const idMapping: Record<string, string> = {};

    const newShapesToAdd = shapes
      .filter(s => idsToCopy.includes(s.id))
      .map(s => {
         let newGroupId = undefined;
         if (s.groupId) {
             if (!groupMapping[s.groupId]) {
                 groupMapping[s.groupId] = `group-${Date.now()}-${Math.random()}`;
             }
             newGroupId = groupMapping[s.groupId];
         }

         const newId = `copy-${Date.now()}-${Math.random()}`;
         idMapping[s.id] = newId;

         return {
            ...s,
            id: newId,
            groupId: newGroupId,
            name: `${s.name}`,
            position: [s.position[0] + 0.5, s.position[1], s.position[2] + 0.5] as [number, number, number],
            rotation: [...s.rotation] as [number, number, number]
         };
      });
      
    // Identify child copies BEFORE mutating parentIds (while idMapping still maps old->new)
    const childCopyIds = new Set(
        newShapesToAdd.filter(s => s.parentId && idMapping[s.parentId]).map(s => s.id)
    );

    // Update parentIds for copied children
    newShapesToAdd.forEach(s => {
        if (s.parentId && idMapping[s.parentId]) {
            s.parentId = idMapping[s.parentId];
        }
    });

    const newShapes = [...shapes, ...newShapesToAdd];
    _commitState(newShapes, layers, guideLines);
    // Select only the top-level copied shapes
    setSelectedIds(newShapesToAdd.filter(s => !childCopyIds.has(s.id)).map(s => s.id));
  }, [_commitState]);

  const groupSelected = useCallback(() => {
      const { selectedIds } = stateRef.current;
      if (selectedIds.length < 2) return;
      const newGroupId = `group-${Date.now()}-${Math.random()}`;
      
      const updates = selectedIds.map(id => ({
          id,
          changes: { groupId: newGroupId }
      }));
      updateShapes(updates);
  }, [updateShapes]);

  const ungroupSelected = useCallback(() => {
      const { selectedIds } = stateRef.current;
      if (selectedIds.length === 0) return;
      const updates = selectedIds.map(id => ({
          id,
          changes: { groupId: undefined }
      }));
      updateShapes(updates);
      setSelectedIds([]);
  }, [updateShapes]);

  // --- Boolean Operation Logic ---

  const subtractSelected = useCallback(() => {
      const { shapes, selectedIds } = stateRef.current;
      // Find selected shapes suitable for boolean operations
      const selectedShapes = shapes.filter(s => selectedIds.includes(s.id) && (s.type === 'flat' || s.type === 'solid'));
      
      if (selectedShapes.length < 2) {
          alert("請至少選擇兩個形狀進行挖孔運算 (1個主體，1個或多個孔洞)");
          return;
      }

      // 1. Identify Base and Cutters
      // Heuristic: The shape with the largest diagonal/area is likely the base
      const getDiagonal = (s: IShape) => {
          let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
          s.points.forEach(p => {
              if (p.x < minX) minX = p.x;
              if (p.x > maxX) maxX = p.x;
              if (p.z < minZ) minZ = p.z;
              if (p.z > maxZ) maxZ = p.z;
          });
          const w = (maxX - minX) * s.scale[0];
          const d = (maxZ - minZ) * s.scale[2];
          return Math.sqrt(w*w + d*d);
      };

      let base = selectedShapes[0];
      let maxDiag = getDiagonal(base);

      selectedShapes.forEach(s => {
          const d = getDiagonal(s);
          if (d > maxDiag) {
              maxDiag = d;
              base = s;
          }
      });

      const cutters = selectedShapes.filter(s => s.id !== base.id);

      // Open Modal instead of window.confirm
      setBooleanModal({ open: true, base, cutters });

  }, []);

  const confirmBooleanOperation = useCallback((isContainer: boolean) => {
      const { shapes, layers, guideLines } = stateRef.current;
      const { base, cutters } = booleanModal;
      if (!base || cutters.length === 0) {
          setBooleanModal({ open: false, base: null, cutters: [] });
          return;
      }

      // 2. Prepare Base Matrix for inverse transformation
      const baseObj = new THREE.Object3D();
      baseObj.position.set(...base.position);
      baseObj.rotation.set(...base.rotation);
      baseObj.scale.set(...base.scale);
      baseObj.updateMatrixWorld();
      const baseInvMatrix = baseObj.matrixWorld.clone().invert();

      // 3. Transform all cutters into Base's local coordinate system
      const newHoles: IPoint[][] = [...(base.holes || [])];

      cutters.forEach(cutter => {
          const cutterObj = new THREE.Object3D();
          cutterObj.position.set(...cutter.position);
          cutterObj.rotation.set(...cutter.rotation);
          cutterObj.scale.set(...cutter.scale);
          cutterObj.updateMatrixWorld();

          // Transform points
          const holePoly: IPoint[] = cutter.points.map(p => {
              const vec = new THREE.Vector3(p.x, 0, p.z);
              // To World
              vec.applyMatrix4(cutterObj.matrixWorld);
              // To Base Local
              vec.applyMatrix4(baseInvMatrix);
              return { x: vec.x, y: 0, z: vec.z };
          });
          
          newHoles.push(holePoly);
      });

      // 4. Update Base shape with new holes
      const updatedBase = {
          ...base,
          holes: newHoles
      };

      // 5. Prepare Final Shapes
      const cutterIds = cutters.map(c => c.id);
      
      // We must use the current `shapes` state for the final filter to ensure we don't revert other changes
      let finalShapes = shapes.filter(s => !cutterIds.includes(s.id) && s.id !== base.id);

      if (isContainer) {
          // If container, we keep cutters but modify them to be thin "floors"
          // This simulates the "blind hole" effect
          const newGroupId = base.groupId || `group-${Date.now()}-${Math.random()}`;
          updatedBase.groupId = newGroupId;

          const bottoms: IShape[] = cutters.map(c => ({
              ...c,
              id: `bottom-${c.id}`,
              type: 'solid',
              height: 0.05, // Thin bottom
              // Align with base bottom
              position: [c.position[0], base.position[1], c.position[2]] as [number, number, number], 
              name: `${c.name} (底)`,
              groupId: newGroupId, // Auto group with base
              layerId: base.layerId
          }));
          
          finalShapes = [...finalShapes, updatedBase, ...bottoms];
      } else {
          finalShapes = [...finalShapes, updatedBase];
      }

      _commitState(finalShapes, layers, guideLines);
      setSelectedIds([base.id]);
      setBooleanModal({ open: false, base: null, cutters: [] });

  }, [booleanModal, _commitState]);

  const cancelBooleanOperation = useCallback(() => {
      setBooleanModal({ open: false, base: null, cutters: [] });
  }, []);

  // Add keyboard shortcuts for undo/redo/grouping
  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          // Skip if focus is on an input/textarea to avoid blocking text editing
          const tag = (e.target as HTMLElement)?.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA') return;

          // Undo: Ctrl + Z
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
              e.preventDefault();
              undo();
          }
          // Redo: Ctrl + Y or Ctrl + Shift + Z
          if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
              e.preventDefault();
              redo();
          }
          // Group: Ctrl + G
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g' && !e.shiftKey) {
              e.preventDefault();
              groupSelected();
          }
          // Ungroup: Ctrl + Shift + G
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g' && e.shiftKey) {
              e.preventDefault();
              ungroupSelected();
          }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, groupSelected, ungroupSelected]);

  // --- Guide Lines Logic ---
  const addGuideLine = useCallback((line: IGuideLine) => {
      const { shapes, layers, guideLines } = stateRef.current;
      const newGuideLines = [...guideLines, line];
      _commitState(shapes, layers, newGuideLines);
  }, [_commitState]);

  const removeGuideLine = useCallback((id: string) => {
      const { shapes, layers, guideLines } = stateRef.current;
      const newGuideLines = guideLines.filter(l => l.id !== id);
      _commitState(shapes, layers, newGuideLines);
  }, [_commitState]);

  const clearGuideLines = useCallback(() => {
      const { shapes, layers } = stateRef.current;
      _commitState(shapes, layers, []);
  }, [_commitState]);

  const clearScene = useCallback(() => {
    _commitState([], DEFAULT_LAYERS, []);
    setSelectedIds([]);
  }, [_commitState]);

  const formatValue = useCallback((val: number) => {
    if (unit === 'cm') {
      const cm = val * 100;
      const rounded = Math.round(cm * 10) / 10; // 精確到 0.1cm
      return Number.isInteger(rounded) ? `${rounded} cm` : `${rounded.toFixed(1)} cm`;
    }
    return `${val.toFixed(3)} m`;
  }, [unit]);

  const selectShape = useCallback((id: string, multi = false) => {
      const { shapes, layers, selectedIds } = stateRef.current;
      const targetShape = shapes.find(s => s.id === id);
      if (!targetShape) return;

      // Ensure we don't select hidden shapes
      const targetLayer = layers.find(l => l.id === targetShape.layerId);
      if (targetLayer && !targetLayer.visible) return;

      let idsToToggle = [id];
      if (targetShape.groupId) {
          idsToToggle = shapes.filter(s => s.groupId === targetShape.groupId).map(s => s.id);
      }

      if (multi) {
          const allSelected = idsToToggle.every(tid => selectedIds.includes(tid));
          if (allSelected) {
              setSelectedIds(prev => prev.filter(pid => !idsToToggle.includes(pid)));
          } else {
              const newSet = new Set([...selectedIds, ...idsToToggle]);
              setSelectedIds(Array.from(newSet));
          }
      } else {
          setSelectedIds(idsToToggle);
      }
  }, []);

  const selectShapes = useCallback((ids: string[]) => {
    const { shapes, layers } = stateRef.current;
    // Filter visible only
    const visibleIds = ids.filter(id => {
        const s = shapes.find(shape => shape.id === id);
        if (!s) return false;
        const l = layers.find(layer => layer.id === s.layerId);
        return l && l.visible;
    });
    
    // Expand groups
    const expandedIds = new Set<string>();
    visibleIds.forEach(id => {
        const s = shapes.find(shape => shape.id === id);
        if (s) {
            if (s.groupId) {
                // Find all siblings
                shapes.filter(sib => sib.groupId === s.groupId).forEach(sib => expandedIds.add(sib.id));
            } else {
                expandedIds.add(s.id);
            }
        }
    });

    setSelectedIds(Array.from(expandedIds));
  }, []);

  const deselectAll = useCallback(() => {
      setSelectedIds([]);
  }, []);

  // --- File I/O ---
  const saveProject = useCallback(() => {
      const { shapes, layers, activeLayerId, guideLines, backgroundImage, backgroundFilename, backgroundOpacity, backgroundScale, backgroundPosition } = stateRef.current;
      const data = {
          version: '1.0.0',
          projectName,
          shapes,
          layers,
          activeLayerId,
          guideLines,
          backgroundImage,
          backgroundFilename,
          backgroundOpacity,
          backgroundScale,
          backgroundPosition,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${projectName}.json`;
      a.click();
      URL.revokeObjectURL(url);
  }, [projectName]);

  const openProject = useCallback((file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
          try {
              const json = JSON.parse(e.target?.result as string);
              if (json.shapes && Array.isArray(json.shapes)) {
                  // Migration for old files: add layerId if missing, migrate rotation number -> euler
                  const migratedShapes = json.shapes.map((s: any) => ({
                      ...s,
                      layerId: s.layerId || DEFAULT_LAYERS[0].id,
                      rotation: typeof s.rotation === 'number' ? [0, s.rotation, 0] : s.rotation || [0, 0, 0]
                  }));
                  
                  setProjectName(json.projectName || '匯入的專案');
                  setShapes(migratedShapes);
                  if (json.layers) setLayers(json.layers);
                  if (json.activeLayerId) setActiveLayerId(json.activeLayerId);
                  if (json.guideLines) setGuideLines(json.guideLines);
                  setBackgroundImage(json.backgroundImage ?? null);
                  setBackgroundFilename(json.backgroundFilename ?? null);
                  if (typeof json.backgroundOpacity === 'number') setBackgroundOpacity(json.backgroundOpacity);
                  if (typeof json.backgroundScale === 'number') setBackgroundScale(json.backgroundScale);
                  if (Array.isArray(json.backgroundPosition)) setBackgroundPosition(json.backgroundPosition);
                  
                  // Reset history
                  setHistory([{ shapes: migratedShapes, layers: json.layers || DEFAULT_LAYERS, guideLines: json.guideLines || [] }]);
                  setHistoryIndex(0);
                  setSelectedIds([]);
              }
          } catch (err) {
              console.error("Invalid file format", err);
              alert("檔案格式錯誤");
          }
      };
      reader.readAsText(file);
  }, []);

  const exportOverlayRef = useRef<((canvas: HTMLCanvasElement) => HTMLCanvasElement) | null>(null);
  const setExportOverlay = useCallback((fn: ((canvas: HTMLCanvasElement) => HTMLCanvasElement) | null) => {
      exportOverlayRef.current = fn;
  }, []);

  const exportImage = useCallback(() => {
      const canvas = document.querySelector('#r3f-main canvas') as HTMLCanvasElement | null;
      if (canvas) {
          const link = document.createElement('a');
          link.download = `${projectName}.png`;
          const exportCanvas = exportOverlayRef.current ? exportOverlayRef.current(canvas) : canvas;
          link.href = exportCanvas.toDataURL('image/png');
          link.click();
      }
  }, [projectName]);

  const exportPDF = useCallback(async () => {
      const canvas = document.querySelector('#r3f-main canvas') as HTMLCanvasElement | null;
      if (!canvas) return;
      const exportCanvas = exportOverlayRef.current ? exportOverlayRef.current(canvas) : canvas;
      const imgData = exportCanvas.toDataURL('image/png');
      const w = exportCanvas.width;
      const h = exportCanvas.height;

      try {
          const { jsPDF } = await import('jspdf');
          const orientation = w >= h ? 'landscape' : 'portrait';
          const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4' });
          const pageW = doc.internal.pageSize.getWidth();
          const pageH = doc.internal.pageSize.getHeight();

          const margin = 10;
          const maxW = pageW - margin * 2;
          const maxH = pageH - margin * 2 - 8;
          const scale = Math.min(maxW / w, maxH / h);
          const imgW = w * scale;
          const imgH = h * scale;
          const imgX = (pageW - imgW) / 2;
          const imgY = margin;

          doc.addImage(imgData, 'PNG', imgX, imgY, imgW, imgH);

          const now = new Date();
          const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
          const name = projectName || '未命名專案';
          doc.setFontSize(8);
          doc.setTextColor(150, 150, 150);
          doc.text(`${name}  ·  ${dateStr}`, margin, pageH - 4);
          doc.save(`${name}.pdf`);
      } catch (e) {
          console.error('PDF 匯出失敗', e);
          alert('PDF 匯出失敗，請稍後再試');
      }
  }, [projectName]);

  const contextValue = useMemo(() => ({
    projectName,
    setProjectName,
    shapes,
    addShape,
    updateShape,
    updateShapePreview,
    updateShapes,
    removeShape,
    decomposeFlat,
    removeSelected,
    replaceShapes,
    copySelected,
    groupSelected,
    ungroupSelected,
    subtractSelected,
    
    booleanModal,
    confirmBooleanOperation,
    cancelBooleanOperation,

    selectedIds,
    selectShape,
    selectShapes,
    deselectAll,
    selectedId: selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null,
    setSelectedId: (id: string | null) => id ? selectShape(id) : deselectAll(),
    tool,
    setTool,
    transformMode,
    setTransformMode,
    clearScene,
    unit,
    setUnit,
    formatValue,
    undo,
    redo,
    canUndo: historyIndex > 0,
    canRedo: historyIndex < history.length - 1,
    wallThickness,
    setWallThickness,
    setMeasurement,
    subscribeMeasurement,
    
    layers,
    activeLayerId,
    setActiveLayerId,
    addLayer,
    removeLayer,
    toggleLayerVisibility,
    updateLayerName,

    guideLines,
    addGuideLine,
    removeGuideLine,
    clearGuideLines,
    
    currentView,
    setCurrentView,

    saveProject,
    openProject,
    exportImage,
    exportPDF,
    setExportOverlay,
    lastAutoSaved,

    isLayerPanelOpen,
    setLayerPanelOpen,
    showAxes,
    setShowAxes,

    backgroundImage,
    setBackgroundImage,
    backgroundFilename,
    setBackgroundFilename,
    backgroundOpacity,
    setBackgroundOpacity,
    backgroundScale,
    setBackgroundScale,
    backgroundPosition,
    setBackgroundPosition,
    isCalibrating,
    setIsCalibrating
  }), [
    projectName, shapes, booleanModal, selectedIds, tool, transformMode, unit, 
    wallThickness, layers, activeLayerId, guideLines, currentView, isLayerPanelOpen, showAxes,
    backgroundImage, backgroundFilename, backgroundOpacity, backgroundScale, backgroundPosition, isCalibrating,
    historyIndex, history.length, addShape, updateShape, updateShapePreview, updateShapes, removeShape,
    decomposeFlat, removeSelected, replaceShapes, copySelected, groupSelected, ungroupSelected,
    subtractSelected, confirmBooleanOperation, cancelBooleanOperation, selectShape, 
    selectShapes, deselectAll, clearScene, formatValue, undo, redo,
    setMeasurement, subscribeMeasurement, addLayer, removeLayer, toggleLayerVisibility, 
    updateLayerName, addGuideLine, removeGuideLine, clearGuideLines, saveProject, openProject, exportImage,
    exportPDF, setExportOverlay, lastAutoSaved
  ]);

  return (
    <AppContext.Provider value={contextValue}>
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used within AppProvider");
  return context;
};
