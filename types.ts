
import { Vector3 } from 'three';

export enum ToolType {
  SELECT = 'SELECT',
  PUSH_PULL = 'PUSH_PULL', // 推拉工具 (調整長寬高)
  ROTATE = 'ROTATE', // 旋轉工具
  DRAW_LINE = 'DRAW_LINE', // 直線
  DRAW_RECT = 'DRAW_RECT', // 矩形
  DRAW_CIRCLE = 'DRAW_CIRCLE', // 圓形
  DRAW_TEXT = 'DRAW_TEXT', // 文字工具
  DIMENSION = 'DIMENSION', // 尺寸標註工具
  GUIDE_LINE = 'GUIDE_LINE', // 輔助線工具
  HAND = 'HAND', // 預覽/漫遊模式
  ERASER = 'ERASER', // 橡皮擦
  DOOR = 'DOOR',   // 門 (2D 平面圖)
  SCALE = 'SCALE', // 比例縮放工具
}

export type ShapeType = 'solid' | 'flat' | 'dimension' | 'line' | 'text' | 'image' | 'door'; // 立體 | 平面 | 標註 | 線 | 文字 | 圖片 | 門

export type TransformMode = 'translate' | 'scale'; // 移動或縮放

export interface IPoint {
  x: number;
  y: number;
  z: number;
}

export interface ILayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
}

export interface CSGOperation {
  op: 'subtract' | 'union';
  shape: IShape;
}

export interface IShape {
  id: string;
  groupId?: string; // ID for grouping multiple objects
  layerId: string; // ID of the layer this shape belongs to
  parentId?: string; // ID of the parent shape (if drawn on a face)
  type: ShapeType;
  points: IPoint[]; // 地面上的 2D 輪廓點
  holes?: IPoint[][]; // 內部的孔洞輪廓點 (Supports subtractive geometry)
  csgOperations?: CSGOperation[]; // CSG operations for cavities/holes
  height: number;
  color: string;
  position: [number, number, number];
  rotation: [number, number, number]; // Euler angles (x, y, z)
  scale: [number, number, number]; // 新增縮放比例
  name: string;
  content?: string; // 文字內容
  fontSize?: number; // 字體大小
  lineWidth?: number; // 線條寬度
  imageUrl?: string; // Base64 image data for image shapes
  opacity?: number; // 透明度 0~1，預設 1（不透明）
  doorDirection?: 'left' | 'right'; // 門的開合方向 (hinge side)
  doorFlipped?: boolean;            // 門向內/外翻轉
}

export interface IGuideLine {
  id: string;
  points: [[number, number, number], [number, number, number]]; // Two points defining the infinite line
}

export interface ISceneState {
  shapes: IShape[];
  layers: ILayer[];
  selectedId: string | null;
  tool: ToolType;
  gridSize: number;
}

// AI Generation Types
export interface AIGeneratedItem {
  name: string;
  width: number;
  depth: number;
  height: number;
  color: string;
  x: number;
  z: number;
}