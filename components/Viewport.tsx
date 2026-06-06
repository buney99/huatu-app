
import React, { useRef, useState, useMemo, useEffect, useCallback, useLayoutEffect } from 'react';
import { Canvas, useThree, ThreeEvent, useFrame } from '@react-three/fiber';
import { OrbitControls, TransformControls, Html, GizmoHelper, GizmoViewport, Text, Billboard } from '@react-three/drei';
import * as THREE from 'three';
import { Evaluator, Brush, SUBTRACTION, ADDITION } from 'three-bvh-csg';
import { mergeVertices } from 'three-stdlib';
import { useApp } from '../context/AppContext';
import { ToolType, IPoint, IShape, IGuideLine, ILayer } from '../types';
import { SNAP_GRID, DEFAULT_COLOR, FLAT_COLOR, DEFAULT_HEIGHT } from '../constants';
import { updatePolygons, blockErasedPolygon } from '../utils/polygonDetection';

// --- Constants ---
const SNAP_THRESHOLD = 0.05; // Ray distance threshold (Reduced for better precision)
const ALIGN_THRESHOLD = 0.4; // Axis alignment threshold
const SNAP_CULLING_DISTANCE = 15; // Distance to ignore geometry snapping

// --- Helper: Get Local Basis Vectors from Normal ---
const getLocalBasis = (normal: THREE.Vector3) => {
    const n = normal.clone().normalize();
    let up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(n.dot(up)) > 0.99) up.set(0, 0, 1);
    
    const right = new THREE.Vector3().crossVectors(n, up).normalize();
    const top = new THREE.Vector3().crossVectors(right, n).normalize(); 
    
    return { right, top, normal: n };
};

// --- Types ---
type SnapType = 'none' | 'grid' | 'vertex' | 'midpoint' | 'edge' | 'face' | 'align' | 'endpoint' | 'axis';
type AlignmentLine = [THREE.Vector3, THREE.Vector3];

interface SnapResult {
    position: THREE.Vector3;
    type: SnapType;
    distance: number;
    snapObjectId?: string;
    snapEdge?: [THREE.Vector3, THREE.Vector3];
    normal?: THREE.Vector3;
}

interface InferenceGuide {
    type: 'x' | 'z';
    start: THREE.Vector3;
    end: THREE.Vector3;
}

type PushPullMode = 'top' | 'side' | 'none';

interface PushPullState {
    mode: PushPullMode;
    hoveredShapeId: string | null;
    hoveredEdgeIndex: number;
    dragStartPoint: THREE.Vector3 | null;
    originalHeight: number;
    originalPoints: IPoint[];
    normal: THREE.Vector3;
    dragHeight?: number;
}

// Rotation types handled internally by hook now
type RotatePhase = 'hover' | 'set-axis-end' | 'set-start' | 'rotating';

interface ShapeRendererProps {
    shape: IShape;
    isSelected: boolean;
    isDraggingTop: boolean;
    dragScaleY: number;
    pushPullHandlers: {
        handlePointerDown: (e: ThreeEvent<PointerEvent>) => void;
        handlePointerUp: () => void;
        handlePointerMove: (e: ThreeEvent<PointerEvent>) => void;
    };
    drawingHandlers: {
        handlePointerDown: (e: ThreeEvent<PointerEvent>) => void;
        handlePointerUp: (e: ThreeEvent<PointerEvent>) => void;
        handlePointerMove?: (e: ThreeEvent<PointerEvent>) => void;
        handleClick: (e: ThreeEvent<MouseEvent>) => void;
    };
    rotateHandlers: {
        handleClick: (e: ThreeEvent<MouseEvent>) => void;
        handlePointerMove: (e: ThreeEvent<PointerEvent>) => void;
    };
    setDraggingState: (isDragging: boolean) => void;
    onShapeRef: (id: string, ref: THREE.Group | null) => void;
    shapeRefs: React.MutableRefObject<Record<string, THREE.Group | null>>;
    setAlignmentLines: (lines: AlignmentLine[]) => void;
    setSnapInfo: (snap: SnapResult | null) => void;
    setMeasurement: (val: string) => void;
    isSnapHovered: boolean;
    
    // Context props for optimization
    unit: string;
    tool: ToolType;
    updateShapes: (updates: { id: string; changes: Partial<IShape> }[]) => void;
    layers: ILayer[];
    selectedIds: string[];
    shapes: IShape[];
    selectShape: (id: string, multi?: boolean) => void;
    updateShape: (id: string, changes: Partial<IShape>) => void;
    removeShape: (id: string) => void;
    guideLines: IGuideLine[];
}

// --- Geometry Helpers ---
const createThreeShape = (points: IPoint[], holes?: IPoint[][]) => {
  const shape = new THREE.Shape();
  if (!points || points.length === 0) return shape;
  if (points[0]) {
    shape.moveTo(points[0].x, -points[0].z); 
    for (let i = 1; i < points.length; i++) {
        if (points[i]) shape.lineTo(points[i].x, -points[i].z);
    }
  }
  shape.closePath();

  // Handle holes
  if (holes && holes.length > 0) {
      holes.forEach(holePoints => {
          if (holePoints.length > 0) {
              const holePath = new THREE.Path();
              holePath.moveTo(holePoints[0].x, -holePoints[0].z);
              for (let i = 1; i < holePoints.length; i++) {
                  holePath.lineTo(holePoints[i].x, -holePoints[i].z);
              }
              holePath.closePath();
              shape.holes.push(holePath);
          }
      });
  }

  return shape;
};

const createCirclePoints = (radius: number, segments = 32): IPoint[] => {
  const points: IPoint[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    points.push({ x: Math.cos(theta) * radius, y: 0, z: Math.sin(theta) * radius });
  }
  return points;
};

const transformPoint = (localP: IPoint, shape: IShape): THREE.Vector3 => {
    if (!localP) return new THREE.Vector3();
    const v = new THREE.Vector3(localP.x, 0, localP.z);
    const scale = shape.scale || [1, 1, 1];
    v.set(v.x * scale[0], v.y * scale[1], v.z * scale[2]);
    const rotation = shape.rotation || [0, 0, 0];
    const euler = new THREE.Euler(...rotation);
    v.applyEuler(euler);
    const position = shape.position || [0, 0, 0];
    v.add(new THREE.Vector3(...position));
    return v;
};

const getShapeBounds = (shape: IShape, currentPos?: THREE.Vector3) => {
    const position = shape.position || [0, 0, 0];
    const pos = currentPos || new THREE.Vector3(...position);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const tempShape = { ...shape, position: [pos.x, pos.y, pos.z] as [number, number, number] };
    
    (shape.points || []).forEach(p => {
         if (!p) return;
         const wp = transformPoint(p, tempShape as IShape);
         if(wp.x < minX) minX = wp.x;
         if(wp.x > maxX) maxX = wp.x;
         if(wp.z < minZ) minZ = wp.z;
         if(wp.z > maxZ) maxZ = wp.z;
    });

    if (minX === Infinity) {
        minX = pos.x; maxX = pos.x;
        minZ = pos.z; maxZ = pos.z;
    }

    return { minX, maxX, minZ, maxZ, centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2, y: pos.y };
};

const distToSegmentSquared = (p: THREE.Vector3, v: THREE.Vector3, w: THREE.Vector3) => {
    const l2 = v.distanceToSquared(w);
    if (l2 === 0) return p.distanceToSquared(v);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.z - v.z) * (w.z - v.z)) / l2;
    t = Math.max(0, Math.min(1, t));
    return (p.x - (v.x + t * (w.x - v.x)))**2 + (p.z - (v.z + t * (w.z - v.z)))**2;
};

const getSegmentIntersection = (p1: IPoint, p2: IPoint, p3: IPoint, p4: IPoint): IPoint | null => {
    if (!p1 || !p2 || !p3 || !p4) return null;
    const d = (p2.x - p1.x) * (p4.z - p3.z) - (p2.z - p1.z) * (p4.x - p3.x);
    if (Math.abs(d) < 1e-9) return null; 

    const u = ((p3.x - p1.x) * (p4.z - p3.z) - (p3.z - p1.z) * (p4.x - p3.x)) / d;
    const v = ((p3.x - p1.x) * (p2.z - p1.z) - (p3.z - p1.z) * (p2.x - p1.x)) / d;

    const TOLERANCE = 1e-5;
    if (u >= -TOLERANCE && u <= 1 + TOLERANCE && v >= -TOLERANCE && v <= 1 + TOLERANCE) {
        return { 
            x: p1.x + u * (p2.x - p1.x), 
            y: 0, 
            z: p1.z + u * (p2.z - p1.z) 
        };
    }
    return null;
};

const isSamePoint = (p1: IPoint, p2: IPoint) => {
    if (!p1 || !p2) return false;
    return Math.abs(p1.x - p2.x) < 1e-4 && Math.abs(p1.z - p2.z) < 1e-4;
};

const cutPolygonBySegment = (polyPoints: IPoint[], lineStart: IPoint, lineEnd: IPoint): { polyA: IPoint[]; polyB: IPoint[]; entry: IPoint; exit: IPoint } | null => {
    interface Intersection { 
        point: IPoint; 
        edgeIndex: number; 
        dist: number; 
    }
    const intersections: Intersection[] = [];

    for (let i = 0; i < polyPoints.length; i++) {
        const p1 = polyPoints[i];
        const p2 = polyPoints[(i + 1) % polyPoints.length];
        if (!p1 || !p2) continue;
        const hit = getSegmentIntersection(p1, p2, lineStart, lineEnd);
        if (hit) {
            const dist = Math.sqrt((hit.x - lineStart.x)**2 + (hit.z - lineStart.z)**2);
            const duplicate = intersections.find(int => isSamePoint(int.point, hit));
            if (!duplicate) {
                intersections.push({ point: hit, edgeIndex: i, dist });
            }
        }
    }

    if (intersections.length < 2) return null;

    intersections.sort((a, b) => a.dist - b.dist);
    
    const startHit = intersections[0];
    const endHit = intersections[intersections.length - 1];

    if (isSamePoint(startHit.point, endHit.point)) return null;

    const getPointsBetween = (startInt: Intersection, endInt: Intersection) => {
        const pts: IPoint[] = [startInt.point];
        let currIdx = startInt.edgeIndex;
        const stopEdgeIdx = endInt.edgeIndex;
        let loops = 0;
        
        while (currIdx !== stopEdgeIdx && loops < polyPoints.length * 2) {
            const nextVertexIdx = (currIdx + 1) % polyPoints.length;
            if (!isSamePoint(polyPoints[nextVertexIdx], startInt.point)) {
                pts.push(polyPoints[nextVertexIdx]);
            }
            currIdx = nextVertexIdx;
            loops++;
        }
        
        if (!isSamePoint(endInt.point, pts[pts.length - 1])) {
            pts.push(endInt.point);
        }
        return pts;
    };

    const polyA = getPointsBetween(startHit, endHit);
    const polyB = getPointsBetween(endHit, startHit);

    if (polyA.length < 3 || polyB.length < 3) return null;

    return { polyA, polyB, entry: startHit.point, exit: endHit.point };
};

const getLineEndpoints = (shape: IShape): [THREE.Vector3, THREE.Vector3] | null => {
    if (shape.name !== 'Edge' && shape.type !== 'line') return null;
    
    if (shape.points.length >= 2) {
        if (!shape.points[0] || !shape.points[1]) return null;
        const p1 = transformPoint(shape.points[0], shape);
        const p2 = transformPoint(shape.points[1], shape);
        return [p1, p2];
    }
    
    return null;
};

const shapeBoundsCache = new WeakMap<IShape, { center: THREE.Vector3, radius: number }>();

const getCachedShapeBounds = (shape: IShape) => {
    if (shapeBoundsCache.has(shape)) {
        return shapeBoundsCache.get(shape)!;
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    (shape.points || []).forEach(p => {
        if (!p) return;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
    });
    const rawCenterX = minX === Infinity ? 0 : (minX + maxX) / 2;
    const rawCenterZ = minZ === Infinity ? 0 : (minZ + maxZ) / 2;
    const radius = minX === Infinity ? 0 : Math.sqrt(Math.pow(maxX - minX, 2) + Math.pow(maxZ - minZ, 2)) / 2;
    const center = transformPoint({x: rawCenterX, y: 0, z: rawCenterZ}, shape);
    const bounds = { center, radius };
    shapeBoundsCache.set(shape, bounds);
    return bounds;
};

const getGeometrySnap = (
    cursorPos: THREE.Vector3, 
    ray: THREE.Ray,
    shapes: IShape[], 
    activePoints: IPoint[] = [],
    threshold: number,
    intersectedObject?: THREE.Intersection
): SnapResult => {
    let fallbackSnap: SnapResult;
    const getShapeUserData = (obj: THREE.Object3D) => {
        if (obj.userData?.isShape) return obj.userData;
        if (obj.parent?.userData?.isShape) return obj.parent.userData;
        return null;
    };
    const shapeData = intersectedObject ? getShapeUserData(intersectedObject.object) : null;
    if (intersectedObject && shapeData) {
        let normal = new THREE.Vector3(0, 1, 0);
        if (intersectedObject.face) {
            const normalMatrix = new THREE.Matrix3().getNormalMatrix(intersectedObject.object.matrixWorld);
            normal = intersectedObject.face.normal.clone().applyMatrix3(normalMatrix).normalize();
        }
        fallbackSnap = { position: intersectedObject.point, type: 'face', distance: 0, snapObjectId: shapeData.id, normal };
    } else {
        fallbackSnap = {
            position: new THREE.Vector3(Math.round(cursorPos.x / SNAP_GRID) * SNAP_GRID, cursorPos.y, Math.round(cursorPos.z / SNAP_GRID) * SNAP_GRID),
            type: 'grid', distance: Infinity, normal: new THREE.Vector3(0, 1, 0)
        };
    }
    let bestVertexSnap: SnapResult | null = null;
    let bestEdgeSnap: SnapResult | null = null;
    let minVertexDist = threshold;
    let minEdgeDist = threshold;
    
    // Check loop closure snap
    if (activePoints && activePoints.length > 0) {
        const startPt = activePoints[0];
        if (startPt) {
            const ptVec = new THREE.Vector3(startPt.x, startPt.y, startPt.z);
            const dist = ray.distanceToPoint(ptVec);
            if (dist < threshold * 1.5) {
                bestVertexSnap = { position: ptVec, type: 'endpoint', distance: dist, normal: new THREE.Vector3(0,1,0) };
                minVertexDist = dist;
            }
        }
    }

    const rayOrigin = ray.origin;
    const rayDir = ray.direction;
    const faceDist = intersectedObject ? intersectedObject.distance : Infinity;

    // Helper: Check a set of points for vertex snapping
    const checkPoints = (points: IPoint[], shape: IShape, hasHeight: boolean, currentH: number) => {
        for (let i = 0; i < points.length; i++) {
            if (!points[i]) continue;
            const worldPt = transformPoint(points[i], shape);
            
            // Calculate distance along ray
            const toPt = new THREE.Vector3().subVectors(worldPt, rayOrigin);
            const distAlongRay = toPt.dot(rayDir);
            
            // Skip if point is behind camera or much further than a hit face
            if (distAlongRay < 0 || (faceDist !== Infinity && distAlongRay > faceDist + 0.5)) continue;

            const dist = ray.distanceToPoint(worldPt);
            if (dist < minVertexDist) {
                bestVertexSnap = { position: worldPt, type: 'vertex', distance: dist, snapObjectId: shape.id, normal: new THREE.Vector3(0,1,0) };
                minVertexDist = dist;
            }
            if (hasHeight) {
                const shapePos = shape.position || [0, 0, 0];
                const worldPtTop = transformPoint(points[i], { ...shape, position: [shapePos[0], shapePos[1] + currentH, shapePos[2]] });
                
                const toPtTop = new THREE.Vector3().subVectors(worldPtTop, rayOrigin);
                const distAlongRayTop = toPtTop.dot(rayDir);
                if (distAlongRayTop < 0 || (faceDist !== Infinity && distAlongRayTop > faceDist + 0.5)) continue;

                const distTop = ray.distanceToPoint(worldPtTop);
                if (distTop < minVertexDist) {
                    bestVertexSnap = { position: worldPtTop, type: 'vertex', distance: distTop, snapObjectId: shape.id, normal: new THREE.Vector3(0,1,0) };
                    minVertexDist = distTop;
                }
            }
        }
    };

    for (const shape of shapes) {
        // Validate shape has position
        if (!shape.position) continue;

        // PERFORMANCE OPTIMIZATION: Distance Culling
        const { center, radius } = getCachedShapeBounds(shape);
        
        if (center.distanceTo(cursorPos) > SNAP_CULLING_DISTANCE + radius * Math.max(shape.scale?.[0] || 1, shape.scale?.[2] || 1)) {
            continue;
        }

        if (shape.type === 'line' || shape.name === 'Edge') {
             const endpoints = getLineEndpoints(shape);
             if (endpoints) {
                 const edgeVec = new THREE.Vector3().subVectors(endpoints[1], endpoints[0]).normalize();
                 for(const ep of endpoints) {
                     const dist = ray.distanceToPoint(ep);
                     if (dist < minVertexDist) {
                         bestVertexSnap = { position: ep, type: 'endpoint', distance: dist, snapObjectId: shape.id, normal: edgeVec };
                         minVertexDist = dist;
                     }
                 }
                 continue; 
             }
        }
        const currentH = (shape.height || 0) * (shape.scale?.[1] || 1);
        const hasHeight = Math.abs(currentH) > 0.001;

        // Check outer points
        if (shape.points) checkPoints(shape.points, shape, hasHeight, currentH);
        
        // Check hole points
        if (shape.holes) {
            shape.holes.forEach(hole => checkPoints(hole, shape, hasHeight, currentH));
        }
    }

    {
        const getTransformedVector = (x: number, y: number, z: number, shape: IShape) => {
            const v = new THREE.Vector3(x, y, z);
            const scale = shape.scale || [1, 1, 1];
            v.set(v.x * scale[0], v.y * scale[1], v.z * scale[2]);
            const rotation = shape.rotation || [0, 0, 0];
            v.applyEuler(new THREE.Euler(...rotation));
            const position = shape.position || [0, 0, 0];
            v.add(new THREE.Vector3(...position));
            return v;
        };

        const checkEdges = (pts: IPoint[], shape: IShape, hasHeight: boolean, currentH: number) => {
            const len = pts.length;
            for (let i = 0; i < len; i++) {
                if (!pts[i]) continue;
                const nextIdx = (i + 1) % len;
                if (!pts[nextIdx]) continue;

                const p1 = getTransformedVector(pts[i].x, 0, pts[i].z, shape);
                const p2 = getTransformedVector(pts[nextIdx].x, 0, pts[nextIdx].z, shape);
                
                const checkSegment = (v1: THREE.Vector3, v2: THREE.Vector3) => {
                    const mid = new THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);
                    
                    // Distance along ray for mid point
                    const toMid = new THREE.Vector3().subVectors(mid, rayOrigin);
                    const distAlongRayMid = toMid.dot(rayDir);
                    
                    if (distAlongRayMid >= 0 && (faceDist === Infinity || distAlongRayMid <= faceDist + 0.5)) {
                        const distMid = ray.distanceToPoint(mid);
                        const edgeVec = new THREE.Vector3().subVectors(v2, v1).normalize();
                        if (distMid < minEdgeDist) {
                            bestEdgeSnap = { position: mid, type: 'midpoint', distance: distMid, snapObjectId: shape.id, snapEdge: [v1, v2], normal: edgeVec };
                            minEdgeDist = distMid;
                        }
                    }

                    const pointOnSegment = new THREE.Vector3();
                    const distSq = ray.distanceSqToSegment(v1, v2, undefined, pointOnSegment);
                    const distEdge = Math.sqrt(distSq);
                    
                    // Distance along ray for the closest point on segment
                    const toPointOnSegment = new THREE.Vector3().subVectors(pointOnSegment, rayOrigin);
                    const distAlongRayEdge = toPointOnSegment.dot(rayDir);

                    if (distEdge < minEdgeDist && distAlongRayEdge >= 0 && (faceDist === Infinity || distAlongRayEdge <= faceDist + 0.5)) {
                        const edgeVec = new THREE.Vector3().subVectors(v2, v1).normalize();
                        bestEdgeSnap = { position: pointOnSegment, type: 'edge', distance: distEdge, snapObjectId: shape.id, snapEdge: [v1, v2], normal: edgeVec };
                        minEdgeDist = distEdge;
                    }
                };
                checkSegment(p1, p2);
                if (hasHeight) {
                    const p1Top = getTransformedVector(pts[i].x, shape.height, pts[i].z, shape);
                    const p2Top = getTransformedVector(pts[nextIdx].x, shape.height, pts[nextIdx].z, shape);
                    checkSegment(p1Top, p2Top); 
                    checkSegment(p1, p1Top);
                }
            }
        };

        for (const shape of shapes) {
            // Validate shape has position
            if (!shape.position) continue;

            // PERFORMANCE OPTIMIZATION: Distance Culling
            const { center, radius } = getCachedShapeBounds(shape);
            
            if (center.distanceTo(cursorPos) > SNAP_CULLING_DISTANCE + radius * Math.max(shape.scale?.[0] || 1, shape.scale?.[2] || 1)) {
                continue;
            }

            const currentH = (shape.height || 0) * (shape.scale?.[1] || 1);
            const hasHeight = Math.abs(currentH) > 0.001;
            
            // Check outer edges
            if (shape.points) checkEdges(shape.points, shape, hasHeight, currentH);
            
            // Check hole edges
            if (shape.holes) {
                shape.holes.forEach(hole => checkEdges(hole, shape, hasHeight, currentH));
            }
        }
    }
    if (bestVertexSnap && bestEdgeSnap) {
        if (bestVertexSnap.distance < bestEdgeSnap.distance * 1.5) return bestVertexSnap;
        else return bestEdgeSnap;
    }
    if (bestVertexSnap) return bestVertexSnap;
    if (bestEdgeSnap) return bestEdgeSnap;
    return fallbackSnap;
};

// ... Components ...

const SimpleLine: React.FC<{ points: (THREE.Vector3 | [number, number, number])[], color: string, dashed?: boolean, opacity?: number, transparent?: boolean, lineWidth?: number, depthTest?: boolean, renderOrder?: number, onPointerDown?: (e: ThreeEvent<PointerEvent>) => void }> = ({ points, color, dashed, opacity, transparent, lineWidth, depthTest = true, renderOrder = 0, onPointerDown }) => {
    const ref = useRef<THREE.Line>(null);
    const geometry = useMemo(() => {
        const pts = points.map(p => {
             if (!p) return new THREE.Vector3();
             return (p instanceof THREE.Vector3 ? p : new THREE.Vector3(...p));
        });
        return new THREE.BufferGeometry().setFromPoints(pts);
    }, [points]);

    useEffect(() => {
        return () => { geometry.dispose(); };
    }, [geometry]);

    useLayoutEffect(() => {
        if (dashed && ref.current) {
            ref.current.computeLineDistances();
        }
        if (ref.current) {
            ref.current.renderOrder = renderOrder;
        }
    }, [dashed, renderOrder]);

    return (
        <line ref={ref as any} onPointerDown={onPointerDown as any}>
            <primitive object={geometry} attach="geometry" />
            {dashed ? ( 
                <lineDashedMaterial 
                    color={color} 
                    dashSize={0.3} 
                    gapSize={0.2} 
                    transparent={transparent} 
                    opacity={opacity} 
                    depthTest={depthTest} 
                    toneMapped={false} 
                /> 
            ) : ( 
                <lineBasicMaterial 
                    color={color} 
                    transparent={transparent} 
                    opacity={opacity} 
                    depthTest={depthTest} 
                    toneMapped={false} 
                /> 
            )}
        </line>
    );
};

const RotationGizmo: React.FC<{
    pivot: THREE.Vector3 | null;
    axis: THREE.Vector3 | null;
    axisPoint1: THREE.Vector3 | null;
    axisPreviewEnd: THREE.Vector3 | null;
}> = ({ pivot, axis, axisPoint1, axisPreviewEnd }) => {
    return (
        <>
            {/* Point 1 sphere + preview line to cursor (set-axis-end phase) */}
            {axisPoint1 && !pivot && (
                <group position={axisPoint1}>
                    <mesh>
                        <sphereGeometry args={[0.12, 16, 16]} />
                        <meshBasicMaterial color="#f97316" depthTest={false} transparent opacity={0.9} />
                    </mesh>
                    {axisPreviewEnd && (
                        <SimpleLine
                            points={[new THREE.Vector3(), new THREE.Vector3().subVectors(axisPreviewEnd, axisPoint1)]}
                            color="#f97316" lineWidth={2} depthTest={false} opacity={0.6}
                        />
                    )}
                </group>
            )}
            {/* Pivot sphere + confirmed axis line (set-start / rotating phase) */}
            {pivot && (
                <group position={pivot}>
                    <mesh>
                        <sphereGeometry args={[0.15, 16, 16]} />
                        <meshBasicMaterial color="#ef4444" depthTest={false} transparent opacity={0.8} />
                    </mesh>
                    {axis && (
                        <SimpleLine
                            points={[
                                new THREE.Vector3().copy(axis).multiplyScalar(-10),
                                new THREE.Vector3().copy(axis).multiplyScalar(10)
                            ]}
                            color="#3b82f6" lineWidth={2} depthTest={false} opacity={0.8}
                        />
                    )}
                </group>
            )}
            {/* Hover preview: small dot at snap point */}
            {!axisPoint1 && !pivot && axisPreviewEnd && (
                <mesh position={axisPreviewEnd}>
                    <sphereGeometry args={[0.08, 12, 12]} />
                    <meshBasicMaterial color="#f97316" depthTest={false} transparent opacity={0.6} />
                </mesh>
            )}
        </>
    );
};

const InferenceGuideRenderer: React.FC<{ guide: InferenceGuide | null }> = ({ guide }) => {
    if (!guide) return null;
    const color = guide.type === 'x' ? '#ef4444' : '#22c55e'; // Red for X, Green for Z
    return (
         <SimpleLine 
            points={[guide.start, guide.end]} 
            color={color} 
            lineWidth={2} 
            depthTest={false} 
            opacity={0.8} 
        />
    );
};

const WorldAxes: React.FC = () => {
    const LEN = 50;
    return (
        <group>
            {/* X axis: Red — positive solid, negative dashed */}
            <SimpleLine points={[[0,0.002,0],[LEN,0.002,0]]} color="#e53e3e" lineWidth={1.5} depthTest={false} renderOrder={2} />
            <SimpleLine points={[[0,0.002,0],[-LEN,0.002,0]]} color="#e53e3e" dashed transparent opacity={0.45} lineWidth={1.5} depthTest={false} renderOrder={2} />
            {/* Z axis: Green — positive solid, negative dashed */}
            <SimpleLine points={[[0,0.002,0],[0,0.002,LEN]]} color="#22c55e" lineWidth={1.5} depthTest={false} renderOrder={2} />
            <SimpleLine points={[[0,0.002,0],[0,0.002,-LEN]]} color="#22c55e" dashed transparent opacity={0.45} lineWidth={1.5} depthTest={false} renderOrder={2} />
            {/* Y axis: Blue — positive solid upward */}
            <SimpleLine points={[[0,0,0],[0,LEN,0]]} color="#3b82f6" lineWidth={1.5} depthTest={false} renderOrder={2} />
            {/* Axis labels */}
            <Text position={[LEN+0.8,0.05,0]} fontSize={0.6} color="#e53e3e" anchorX="left" depthOffset={-1}>X</Text>
            <Text position={[0,0.05,LEN+0.8]} fontSize={0.6} color="#22c55e" anchorX="center" depthOffset={-1}>Z</Text>
            <Text position={[0.3,LEN+0.8,0]} fontSize={0.6} color="#3b82f6" anchorX="left" depthOffset={-1}>Y</Text>
        </group>
    );
};

const GuideLinesRenderer: React.FC<{ lines: IGuideLine[] }> = ({ lines }) => {
    const { tool, removeGuideLine } = useApp();
    if (lines.length === 0) return null;
    return (
        <group renderOrder={999}>
            {lines.map((line) => {
                const p1 = new THREE.Vector3(...line.points[0]);
                const p2 = new THREE.Vector3(...line.points[1]);
                const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
                const start = p1.clone().add(dir.clone().multiplyScalar(-5000));
                const end = p1.clone().add(dir.clone().multiplyScalar(5000));
                return (
                    <SimpleLine 
                        key={line.id} 
                        points={[start, end]} 
                        color="#f59e0b" 
                        dashed 
                        lineWidth={1} 
                        depthTest={false} 
                        opacity={0.8} 
                        onPointerDown={(e) => {
                            if (tool === ToolType.ERASER) {
                                e.stopPropagation();
                                removeGuideLine(line.id);
                            }
                        }}
                    />
                );
            })}
        </group>
    );
};

const DimensionLabel: React.FC<{ position: THREE.Vector3; text: string; color?: string }> = ({ position, text, color = "#333" }) => {
    return (
        <Html position={position} center zIndexRange={[28, 0]} style={{ pointerEvents: 'none' }}>
            <div
                translate="no"
                className="px-1 py-px bg-white/97 border shadow-sm rounded text-[9px] font-bold font-mono whitespace-nowrap select-none flex items-center backdrop-blur-sm"
                style={{ borderColor: color, color: '#1e293b', fontSize: '9px', lineHeight: '1.4' }}
            >
                {text}
            </div>
        </Html>
    );
};

// Fixed-position overlay label. Appends a div to document.body and positions it via a
// native requestAnimationFrame loop (NOT useFrame), because useFrame depends on a
// Three.js groupRef that may be null on the first frame after mount.
// Position is computed directly from the `position` prop via a ref, so no Three.js
// object is needed and there is no stale-closure risk.
const DimensionLabel2D: React.FC<{ position: THREE.Vector3; text: string; color?: string }> = ({ position, text, color = "#0ea5e9" }) => {
    const { camera, gl } = useThree();
    const divRef = useRef<HTMLDivElement | null>(null);
    const tmpVec = useMemo(() => new THREE.Vector3(), []);
    // Keep latest position in a ref so the rAF callback always reads current value
    const posRef = useRef(position);
    posRef.current = position;

    // Create the fixed-position div once (tied to canvas DOM element lifetime).
    useLayoutEffect(() => {
        const div = document.createElement('div');
        div.style.cssText = [
            'position:fixed',
            'left:0',
            'top:0',
            'pointer-events:none',
            'z-index:28',
            `border:1px solid ${color}`,
            'background:rgba(255,255,255,0.97)',
            'border-radius:3px',
            'padding:1px 5px',
            'font:bold 9px/1.4 monospace',
            'white-space:nowrap',
            'color:#1e293b',
            'box-shadow:0 1px 3px rgba(0,0,0,0.08)',
            'transform:translate(-9999px,-9999px)',
        ].join(';');
        div.textContent = text;
        document.body.appendChild(div);
        divRef.current = div;
        return () => {
            if (document.body.contains(div)) document.body.removeChild(div);
            divRef.current = null;
        };
    }, [gl.domElement]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => { if (divRef.current) divRef.current.textContent = text; }, [text]);
    useEffect(() => { if (divRef.current) divRef.current.style.borderColor = color; }, [color]);

    // Native rAF loop: runs every frame independently of R3F's render loop.
    // camera and gl are stable R3F refs, so this effect runs once on mount.
    useEffect(() => {
        let rafId: number;
        const update = () => {
            const div = divRef.current;
            if (div) {
                tmpVec.copy(posRef.current).project(camera);
                const rect = gl.domElement.getBoundingClientRect();
                const x = rect.left + (tmpVec.x + 1) / 2 * rect.width;
                const y = rect.top  + (-tmpVec.y + 1) / 2 * rect.height;
                div.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px)`;
            }
            rafId = requestAnimationFrame(update);
        };
        rafId = requestAnimationFrame(update);
        return () => cancelAnimationFrame(rafId);
    }, [camera, gl, tmpVec]);

    return null;
};

// WebGL-rendered dimension label — captured by canvas.toDataURL() for image/PDF export.
// Uses Billboard so the label always faces the camera, same visual behaviour as <Html>.
// The OUTER group handles position + scale; Billboard (inside) handles camera-facing rotation.
// Scaling the outer group avoids any interaction with Billboard's internal coordinate system.
const DimensionLabelGL: React.FC<{ position: THREE.Vector3; text: string; color?: string }> = ({ position, text, color = "#0ea5e9" }) => {
    const outerRef = useRef<THREE.Group>(null);
    const _tempVec = useMemo(() => new THREE.Vector3(), []);

    const charCount = text.length;
    const bgW = Math.max(0.8, charCount * 0.175 + 0.35);
    const bgH = 0.44;

    // onBeforeRender fires inside gl.render(), AFTER scene.updateMatrixWorld() has run.
    // getWorldPosition() reads from the group's already-computed matrixWorld, which
    // reflects the committed Three.js state for this frame — guaranteeing that the
    // distance used for scale always matches the position the group is actually rendered at.
    // positionRef (render-phase update) was wrong here because React's render phase can
    // run before commit, leaving positionRef ahead of the Three.js group's actual position.
    const handleBeforeRender = useCallback(
        (_renderer: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera) => {
            const group = outerRef.current;
            if (!group) return;
            group.getWorldPosition(_tempVec);
            const dist = Math.max(1, camera.position.distanceTo(_tempVec));
            group.scale.setScalar(dist * 0.12);
            group.updateMatrixWorld(true);
        },
        [_tempVec]
    );

    return (
        <group ref={outerRef} position={[position.x, position.y, position.z]}>
            <Billboard>
                {/* Border — onBeforeRender fires here first, updates group scale for this frame */}
                <mesh renderOrder={997} onBeforeRender={handleBeforeRender as any}>
                    <planeGeometry args={[bgW + 0.1, bgH + 0.08]} />
                    <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.9} />
                </mesh>
                {/* White fill */}
                <mesh renderOrder={998} position={[0, 0, 0.001]}>
                    <planeGeometry args={[bgW, bgH]} />
                    <meshBasicMaterial color="#ffffff" depthTest={false} transparent opacity={0.97} />
                </mesh>
                {/* Text */}
                <Text
                    position={[0, 0, 0.002]}
                    fontSize={0.28}
                    color="#1e293b"
                    anchorX="center"
                    anchorY="middle"
                    depthTest={false}
                    renderOrder={999}
                >
                    {text}
                </Text>
            </Billboard>
        </group>
    );
};

const DimensionShape: React.FC<{ shape: IShape; isSelected: boolean; onSelect: (e: ThreeEvent<MouseEvent>) => void }> = ({ shape, isSelected, onSelect }) => {
    const { formatValue, tool, updateShape, removeShape } = useApp();
    const { camera, gl } = useThree();

    // Local drag state: null = use shape data, non-null = live preview during drag
    const [localPts, setLocalPts] = useState<[THREE.Vector3|null, THREE.Vector3|null, THREE.Vector3|null]>([null,null,null]);
    const localPtsRef = useRef<[THREE.Vector3|null, THREE.Vector3|null, THREE.Vector3|null]>([null,null,null]);
    const dragInitRef = useRef<[THREE.Vector3, THREE.Vector3, THREE.Vector3] | null>(null);
    const dragHitStartRef = useRef<THREE.Vector3 | null>(null);
    const rafRef = useRef<number | null>(null);

    if (!shape.points || shape.points.length < 3) return null;
    if (!shape.points[0] || !shape.points[1] || !shape.points[2]) return null;

    const [lp1, lp2, lp3] = localPts;
    const p1 = lp1 ?? new THREE.Vector3(shape.points[0].x, shape.points[0].y, shape.points[0].z);
    const p2 = lp2 ?? new THREE.Vector3(shape.points[1].x, shape.points[1].y, shape.points[1].z);
    const p3Source = (lp3 ?? new THREE.Vector3(shape.points[2].x, shape.points[2].y, shape.points[2].z)).clone();
    if (Math.abs(p1.y - p2.y) < 0.05) p3Source.y = p1.y;

    const v12 = new THREE.Vector3().subVectors(p2, p1);
    const lenSq = v12.lengthSq();
    const proj = lenSq > 0 ? new THREE.Vector3().subVectors(p3Source, p1).dot(v12) / lenSq : 0;
    const offsetVector = new THREE.Vector3().subVectors(p3Source, p1.clone().add(v12.clone().multiplyScalar(proj)));

    const dimStart = p1.clone().add(offsetVector);
    const dimEnd   = p2.clone().add(offsetVector);
    const midPoint = new THREE.Vector3().addVectors(dimStart, dimEnd).multiplyScalar(0.5);

    const GAP = 0.05;
    const offsetDir = offsetVector.clone().normalize();
    const useGap = offsetVector.length() > GAP * 1.5;
    const ext1Start = useGap ? p1.clone().add(offsetDir.clone().multiplyScalar(GAP)) : p1.clone();
    const ext2Start = useGap ? p2.clone().add(offsetDir.clone().multiplyScalar(GAP)) : p2.clone();

    const color = isSelected ? '#0284c7' : '#0ea5e9';
    const isSelectMode = tool === ToolType.SELECT;
    const isEraserMode = tool === ToolType.ERASER;

    // type: 'p1' | 'p2' = move endpoint; 'p3' = adjust offset; 'all' = translate dim line only (p3 delta, p1/p2 fixed)
    const startDrag = (e: ThreeEvent<PointerEvent>, type: 'p1'|'p2'|'p3'|'all') => {
        e.stopPropagation();
        if (!isSelected) onSelect(e as unknown as ThreeEvent<MouseEvent>);
        document.body.style.cursor = 'grabbing';

        const initP1 = p1.clone(), initP2 = p2.clone(), initP3 = p3Source.clone();
        dragInitRef.current = [initP1, initP2, initP3];

        // Shared offset plane for 'p3' and 'all' modes
        const offsetPlane = Math.abs(initP1.y - initP2.y) < 0.1
            ? new THREE.Plane(new THREE.Vector3(0, 1, 0), -initP1.y)
            : new THREE.Plane().setFromNormalAndCoplanarPoint(
                new THREE.Vector3().copy(camera.position).sub(initP1).normalize(), initP1);

        // Record initial hit for delta-based drag
        const initRay = new THREE.Raycaster();
        initRay.setFromCamera(e.pointer, camera);
        const hitStart = new THREE.Vector3();
        if (initRay.ray.intersectPlane(offsetPlane, hitStart)) dragHitStartRef.current = hitStart.clone();

        const onMove = (ev: PointerEvent) => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(() => {
                const ray = new THREE.Raycaster();
                const ndc = new THREE.Vector2(
                    (ev.clientX / gl.domElement.clientWidth) * 2 - 1,
                    -(ev.clientY / gl.domElement.clientHeight) * 2 + 1,
                );
                ray.setFromCamera(ndc, camera);
                const hit = new THREE.Vector3();
                const [ip1, ip2, ip3] = dragInitRef.current!;

                if (type === 'p1' || type === 'p2') {
                    const refY = type === 'p1' ? ip1.y : ip2.y;
                    if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0), -refY), hit)) {
                        const next: [THREE.Vector3|null, THREE.Vector3|null, THREE.Vector3|null] =
                            type === 'p1' ? [hit.clone(), null, null] : [null, hit.clone(), null];
                        localPtsRef.current = next;
                        setLocalPts([...next]);
                    }
                } else if (type === 'p3') {
                    if (ray.ray.intersectPlane(offsetPlane, hit)) {
                        const next: [THREE.Vector3|null, THREE.Vector3|null, THREE.Vector3|null] = [null, null, hit.clone()];
                        localPtsRef.current = next;
                        setLocalPts([...next]);
                    }
                } else {
                    // 'all': only move p3 by delta — p1/p2 stay fixed, dim line translates without detaching from endpoints
                    if (dragHitStartRef.current && ray.ray.intersectPlane(offsetPlane, hit)) {
                        const delta = hit.clone().sub(dragHitStartRef.current);
                        const next: [THREE.Vector3|null, THREE.Vector3|null, THREE.Vector3|null] = [
                            null, null, ip3.clone().add(delta),
                        ];
                        localPtsRef.current = next;
                        setLocalPts([...next]);
                    }
                }
            });
        };

        const onUp = () => {
            document.body.style.cursor = 'default';
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);

            const [fp1, fp2, fp3] = localPtsRef.current;
            const [ip1, ip2, ip3] = dragInitRef.current!;
            // Batch with setLocalPts so only one render occurs
            updateShape(shape.id, {
                points: [
                    fp1 ? {x:fp1.x,y:fp1.y,z:fp1.z} : {x:ip1.x,y:ip1.y,z:ip1.z},
                    fp2 ? {x:fp2.x,y:fp2.y,z:fp2.z} : {x:ip2.x,y:ip2.y,z:ip2.z},
                    fp3 ? {x:fp3.x,y:fp3.y,z:fp3.z} : {x:ip3.x,y:ip3.y,z:ip3.z},
                ]
            });
            setLocalPts([null,null,null]);
            localPtsRef.current = [null,null,null];
            dragInitRef.current = null;
            dragHitStartRef.current = null;
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };

    const handleLineDown = (e: ThreeEvent<PointerEvent>) => {
        if (isEraserMode) { e.stopPropagation(); removeShape(shape.id); return; }
        if (!isSelectMode || e.button !== 0) return;
        startDrag(e, 'all');
    };

    return (
        <>
            {/* Dimension lines */}
            <group
                onPointerDown={isSelectMode || isEraserMode ? handleLineDown : undefined}
                onPointerOver={(e) => { if (isSelectMode) { e.stopPropagation(); document.body.style.cursor = 'grab'; } }}
                onPointerOut={() => { if (isSelectMode) document.body.style.cursor = 'default'; }}
            >
                <SimpleLine points={[dimStart, dimEnd]} color={color} depthTest={false} />
                <SimpleLine points={[ext1Start, dimStart]} color="#999" dashed depthTest={false} />
                <SimpleLine points={[ext2Start, dimEnd]}  color="#999" dashed depthTest={false} />
                <mesh position={dimStart}><sphereGeometry args={[0.03]} /><meshBasicMaterial color={color} depthTest={false} /></mesh>
                <mesh position={dimEnd}>  <sphereGeometry args={[0.03]} /><meshBasicMaterial color={color} depthTest={false} /></mesh>
            </group>

            {/* Editing handles — only visible when selected in SELECT mode */}
            {isSelected && isSelectMode && (<>
                {/* Orange handle at midPoint → adjust offset (p3) */}
                <mesh position={midPoint} renderOrder={999}
                    onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'ns-resize'; }}
                    onPointerOut={() => { document.body.style.cursor = 'default'; }}
                    onPointerDown={(e) => { if (e.button === 0) startDrag(e, 'p3'); }}>
                    <sphereGeometry args={[0.06]} />
                    <meshBasicMaterial color="#f59e0b" depthTest={false} />
                </mesh>
                {/* Green handle at p1 → move measurement start */}
                <mesh position={p1} renderOrder={999}
                    onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'crosshair'; }}
                    onPointerOut={() => { document.body.style.cursor = 'default'; }}
                    onPointerDown={(e) => { if (e.button === 0) startDrag(e, 'p1'); }}>
                    <sphereGeometry args={[0.07]} />
                    <meshBasicMaterial color="#22c55e" depthTest={false} />
                </mesh>
                {/* Green handle at p2 → move measurement end */}
                <mesh position={p2} renderOrder={999}
                    onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'crosshair'; }}
                    onPointerOut={() => { document.body.style.cursor = 'default'; }}
                    onPointerDown={(e) => { if (e.button === 0) startDrag(e, 'p2'); }}>
                    <sphereGeometry args={[0.07]} />
                    <meshBasicMaterial color="#22c55e" depthTest={false} />
                </mesh>
            </>)}

            <DimensionLabel2D position={midPoint} text={formatValue(p1.distanceTo(p2))} color={color} />
        </>
    );
};

const AlignmentLinesRenderer: React.FC<{ lines: AlignmentLine[] }> = ({ lines }) => {
    if (lines.length === 0) return null;
    return ( <group>{lines.map((line, i) => (<SimpleLine key={i} points={line} color="red" dashed lineWidth={2} depthTest={false} opacity={0.8} />))}</group> );
};

// Standalone: snap cursor to world X/Z axes (the floor-plan origin cross).
// Returns a SnapResult (type='axis') or null if nothing within threshold.
const WORLD_AXES: { dir: THREE.Vector3; edgeDir: [number, number, number] }[] = [
    { dir: new THREE.Vector3(1, 0, 0), edgeDir: [1, 0, 0] }, // X axis (red)
    { dir: new THREE.Vector3(0, 0, 1), edgeDir: [0, 0, 1] }, // Z axis (green)
];
const getAxisSnap = (ray: THREE.Ray, threshold = SNAP_THRESHOLD): SnapResult | null => {
    const AXIS_THRESHOLD = threshold * 2;
    const axisOrigin = new THREE.Vector3(0, 0, 0);
    let bestDist = AXIS_THRESHOLD;
    let bestPoint: THREE.Vector3 | null = null;
    let bestEdgeDir: [number, number, number] = [1, 0, 0];

    for (const ax of WORLD_AXES) {
        const cross = new THREE.Vector3().crossVectors(ray.direction, ax.dir);
        if (cross.lengthSq() <= 0.0001) continue; // ray parallel to axis
        const n = cross.normalize();
        const n2 = new THREE.Vector3().crossVectors(ax.dir, n);
        const denom = ray.direction.dot(n2);
        if (Math.abs(denom) < 0.0001) continue;
        const t = new THREE.Vector3().subVectors(axisOrigin, ray.origin).dot(n2) / denom;
        if (t < 0) continue;
        const rayPt = ray.origin.clone().add(ray.direction.clone().multiplyScalar(t));
        // Project onto axis to get actual snap point
        const snapPt = axisOrigin.clone().add(ax.dir.clone().multiplyScalar(rayPt.clone().sub(axisOrigin).dot(ax.dir)));
        const dist = ray.distanceToPoint(snapPt);
        if (dist < bestDist) {
            bestDist = dist;
            bestPoint = snapPt;
            bestEdgeDir = ax.edgeDir;
        }
    }

    if (!bestPoint) return null;
    const ed = bestEdgeDir;
    return {
        position: bestPoint,
        type: 'axis',
        distance: bestDist,
        normal: new THREE.Vector3(0, 1, 0),
        snapEdge: [
            bestPoint.clone().add(new THREE.Vector3(-ed[0] * 6, 0, -ed[2] * 6)),
            bestPoint.clone().add(new THREE.Vector3( ed[0] * 6, 0,  ed[2] * 6)),
        ],
    };
};

// Standalone: compute the nearest guide-line × guide-line intersection to a ray.
// Returns a SnapResult (type='vertex') or null if nothing within threshold.
const getGuideLineIntersectionSnap = (ray: THREE.Ray, guideLines: IGuideLine[], threshold = SNAP_THRESHOLD): SnapResult | null => {
    if (guideLines.length < 2) return null;
    let bestDist = threshold;
    let bestPoint: THREE.Vector3 | null = null;

    for (let i = 0; i < guideLines.length; i++) {
        for (let j = i + 1; j < guideLines.length; j++) {
            const g1 = guideLines[i], g2 = guideLines[j];
            const p1 = new THREE.Vector3(...g1.points[0]);
            const d1 = new THREE.Vector3(...g1.points[1]).sub(p1).normalize();
            const p2 = new THREE.Vector3(...g2.points[0]);
            const d2 = new THREE.Vector3(...g2.points[1]).sub(p2).normalize();
            const cross = new THREE.Vector3().crossVectors(d1, d2);
            if (cross.lengthSq() <= 0.0001) continue; // parallel
            const n = cross.clone().normalize();
            const n1 = new THREE.Vector3().crossVectors(d1, n);
            const n2 = new THREE.Vector3().crossVectors(d2, n);
            const c1 = p1.clone().add(d1.clone().multiplyScalar(new THREE.Vector3().subVectors(p2, p1).dot(n2) / d1.dot(n2)));
            const c2 = p2.clone().add(d2.clone().multiplyScalar(new THREE.Vector3().subVectors(p1, p2).dot(n1) / d2.dot(n1)));
            if (c1.distanceTo(c2) >= 0.01) continue; // skew (3-D miss)
            const pt = c1.clone().add(c2).multiplyScalar(0.5);
            const dist = ray.distanceToPoint(pt);
            if (dist < bestDist) { bestDist = dist; bestPoint = pt; }
        }
    }
    if (!bestPoint) return null;
    return { position: bestPoint, type: 'vertex', distance: bestDist, normal: new THREE.Vector3(0, 1, 0) };
};

const getSnapPoint = (point: THREE.Vector3, ray: THREE.Ray, shapes: IShape[], tool: ToolType, inferenceGuide: InferenceGuide | null, guideLines?: IGuideLine[], intersectedObject?: THREE.Intersection): SnapResult => {
    // Adaptive threshold: scale with camera distance so the snap zone is always the
    // same apparent size on screen regardless of zoom level. Snapped coordinates are
    // still exact vertex/edge positions — only the activation radius changes.
    // SNAP_SCREEN_FACTOR ≈ 2.5% of camera distance → ~20px snap zone at typical FOV.
    const cameraDistance = ray.origin.distanceTo(point);
    const adaptiveThreshold = Math.max(SNAP_THRESHOLD, Math.min(cameraDistance * 0.025, 1.0));

    const geometrySnap = getGeometrySnap(point, ray, shapes, [], adaptiveThreshold, intersectedObject);

    // World axis snap — compete with geometry snap by distance
    const axSnap = getAxisSnap(ray, adaptiveThreshold);
    if (axSnap) {
        if (geometrySnap.type === 'none' || axSnap.distance < geometrySnap.distance) {
            return axSnap;
        }
    }

    // Guide-line × guide-line intersection — compete with geometry snap by distance
    if (guideLines && guideLines.length >= 2) {
        const glSnap = getGuideLineIntersectionSnap(ray, guideLines, adaptiveThreshold);
        if (glSnap) {
            // Win if: no geometry snap, OR guide intersection is closer than geometry snap
            if (geometrySnap.type === 'none' || glSnap.distance < geometrySnap.distance) {
                return glSnap;
            }
        }
    }

    if (geometrySnap.type !== 'none' && geometrySnap.distance < adaptiveThreshold) {
        return geometrySnap;
    }

    if (guideLines && guideLines.length > 0) {
        // Snap to guideline edges
        let bestEdgeDist = adaptiveThreshold;
        let bestEdgePoint: THREE.Vector3 | null = null;
        let bestEdge: [THREE.Vector3, THREE.Vector3] | null = null;

        for (const g of guideLines) {
            const p1 = new THREE.Vector3(...g.points[0]);
            const p2 = new THREE.Vector3(...g.points[1]);
            const line = new THREE.Line3(p1, p2);
            
            // Since guidelines are infinite, we need to find the closest point on the infinite line to the ray
            const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
            
            // Cross product of ray direction and line direction
            const cross = new THREE.Vector3().crossVectors(ray.direction, dir);
            if (cross.lengthSq() > 0.0001) {
                const n = cross.normalize();
                const n1 = new THREE.Vector3().crossVectors(ray.direction, n);
                const n2 = new THREE.Vector3().crossVectors(dir, n);
                
                const c1 = ray.origin.clone().add(ray.direction.clone().multiplyScalar(new THREE.Vector3().subVectors(p1, ray.origin).dot(n2) / ray.direction.dot(n2)));
                const c2 = p1.clone().add(dir.clone().multiplyScalar(new THREE.Vector3().subVectors(ray.origin, p1).dot(n1) / dir.dot(n1)));
                
                const distToRay = c1.distanceTo(c2);
                if (distToRay < bestEdgeDist) {
                    bestEdgeDist = distToRay;
                    bestEdgePoint = c2;
                    // Create a segment centered around the snap point for visual indication
                    bestEdge = [
                        c2.clone().add(dir.clone().multiplyScalar(-5)),
                        c2.clone().add(dir.clone().multiplyScalar(5))
                    ];
                }
            }
        }

        if (bestEdgePoint && bestEdge) {
            return { position: bestEdgePoint, type: 'edge', distance: bestEdgeDist, snapEdge: bestEdge, normal: new THREE.Vector3(0, 1, 0) };
        }
    }

    if (inferenceGuide) {
        const line = new THREE.Line3(inferenceGuide.start, inferenceGuide.end);
        const closest = new THREE.Vector3();
        line.closestPointToPoint(point, true, closest);
        const d = point.distanceTo(closest);
        if (d < 0.2) { // Use 0.2 to match the visibility threshold of the inference guide
            return { position: closest, type: 'align', distance: d, normal: new THREE.Vector3(0, 1, 0) };
        }
    }

    const snappedX = Math.round(point.x / SNAP_GRID) * SNAP_GRID;
    const snappedZ = Math.round(point.z / SNAP_GRID) * SNAP_GRID;
    let snappedY = point.y;
    if (Math.abs(point.y) < 0.05) snappedY = 0;
    const gridPoint = new THREE.Vector3(snappedX, snappedY, snappedZ);
    return { position: gridPoint, type: 'grid', distance: point.distanceTo(gridPoint), normal: new THREE.Vector3(0, 1, 0) };
};

const SnapIndicator: React.FC<{ position: THREE.Vector3; type: SnapType; snapEdge?: [THREE.Vector3, THREE.Vector3], normal?: THREE.Vector3; cameraDistance?: number }> = ({ position, type, snapEdge, normal, cameraDistance = 5 }) => {
    if (type === 'grid' || type === 'none') return null;
    // Scale indicator size with camera distance so it's always visible at any zoom level.
    // Base size is tuned for cameraDistance ≈ 5m; clamp to keep it sensible at extremes.
    const sizeScale = Math.max(0.5, Math.min(cameraDistance / 5, 4));
    let color = '#f59e0b'; let size = 0.08 * sizeScale; let geometry = <sphereGeometry args={[size]} />;
    if (type === 'endpoint' || type === 'vertex') { color = '#10b981'; size = 0.12 * sizeScale; geometry = <sphereGeometry args={[size]} />; }
    else if (type === 'midpoint') { color = '#f59e0b'; size = 0.12 * sizeScale; geometry = <coneGeometry args={[size, size * 2, 4]} />; }
    else if (type === 'edge') { color = '#ef4444'; size = 0.06 * sizeScale; geometry = <boxGeometry args={[size * 1.5, size * 1.5, size * 1.5]} />; }
    else if (type === 'face') { color = '#3b82f6'; }
    else if (type === 'axis') { color = '#f97316'; size = 0.1 * sizeScale; geometry = <octahedronGeometry args={[size]} />; }

    const rotation: [number, number, number] = [0, 0, 0];
    if (type === 'face' && normal) {
        const baseNormal = new THREE.Vector3(0, 0, 1); // PlaneGeometry faces +Z by default
        const quaternion = new THREE.Quaternion().setFromUnitVectors(baseNormal, normal.clone().normalize());
        const euler = new THREE.Euler().setFromQuaternion(quaternion);
        rotation[0] = euler.x;
        rotation[1] = euler.y;
        rotation[2] = euler.z;
    } else if (type === 'face') {
        rotation[0] = -Math.PI / 2;
    }

    return (
        <group position={position}>
            {type === 'face' ? ( 
                <group rotation={rotation}>
                    <mesh>
                        <planeGeometry args={[0.2, 0.2]} />
                        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.5} side={THREE.DoubleSide} />
                    </mesh>
                    <lineSegments>
                        <edgesGeometry args={[new THREE.PlaneGeometry(0.2, 0.2)]} />
                        <lineBasicMaterial color={color} depthTest={false} />
                    </lineSegments>
                </group>
            ) : ( 
                <mesh>{geometry}<meshBasicMaterial color={color} depthTest={false} /></mesh> 
            )}
            {type === 'edge' && snapEdge && (<SimpleLine points={[snapEdge[0], snapEdge[1]]} color="#ef4444" lineWidth={3} depthTest={false} />)}
            {type === 'midpoint' && snapEdge && (<SimpleLine points={[snapEdge[0], snapEdge[1]]} color="#f59e0b" lineWidth={4} depthTest={false} />)}
            {type === 'axis' && snapEdge && (<SimpleLine points={[snapEdge[0], snapEdge[1]]} color="#f97316" lineWidth={3} depthTest={false} />)}
        </group>
    );
};

const CursorTooltip: React.FC<{ text: string; position: THREE.Vector3; type?: SnapType }> = ({ text, position, type }) => {
    if (type === 'grid' || type === 'none') return null;
    
    let displayType = ''; 
    let bgColor = 'bg-slate-900/90'; 
    let textColor = 'text-white';
    let borderColor = 'border-white/20';
    let icon = '';

    switch(type) {
        case 'vertex': 
        case 'endpoint':
            displayType = '節點 (Node)'; bgColor = 'bg-emerald-600/95'; borderColor = 'border-emerald-300'; icon = '🔴'; break;
        case 'midpoint':
            displayType = '⚠ 中點 (Midpoint)'; bgColor = 'bg-amber-500/95'; borderColor = 'border-amber-300'; icon = ''; break;
        case 'edge': 
            displayType = '邊緣 (Edge)'; bgColor = 'bg-red-500/95'; borderColor = 'border-red-300'; icon = '📏'; break;
        case 'face': 
            displayType = '表面 (Face)'; bgColor = 'bg-blue-600/95'; borderColor = 'border-blue-300'; icon = '⬜'; break;
        case 'align':
            displayType = '對齊 (Align)'; bgColor = 'bg-pink-500/95'; borderColor = 'border-pink-300'; icon = '🎯'; break;
        case 'axis':
            displayType = '軸線 (Axis)'; bgColor = 'bg-orange-500/95'; borderColor = 'border-orange-300'; icon = '✛'; break;
        default: displayType = '';
    }

    const displayText = displayType || text;
    
    return (
        <Html position={[position.x, position.y, position.z]} style={{ pointerEvents: 'none', zIndex: 100 }}>
            <div 
                translate="no"
                className={`${bgColor} ${textColor} text-xs px-3 py-1.5 rounded-full shadow-[0_4px_12px_rgba(0,0,0,0.3)] backdrop-blur-md border-2 ${borderColor} whitespace-nowrap flex items-center gap-2 font-bold transition-all duration-150 scale-110`}
                style={{ transform: 'translate(20px, -120%)' }}
            >
                <span className="text-base">{icon}</span>
                <span>{displayText}</span>
            </div>
        </Html>
    );
};


const SelectionBox: React.FC<{ start: THREE.Vector2 | null, end: THREE.Vector2 | null }> = ({ start, end }) => {
    if (!start || !end) return null;
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    
    // Left-to-Right (Window Selection) vs Right-to-Left (Crossing Selection)
    const isLeftToRight = end.x >= start.x;
    
    return (
        <div 
            className={`fixed pointer-events-none z-[9999] ${
                isLeftToRight 
                    ? "border border-blue-500 bg-blue-500/20" 
                    : "border border-dashed border-green-500 bg-green-500/20"
            }`}
            style={{ left, top, width, height }}
        />
    );
};

const useShapeDrag = (
    shape: IShape,
    shapes: IShape[],
    isSelected: boolean,
    tool: ToolType,
    updateShapes: (updates: { id: string; changes: Partial<IShape> }[]) => void,
    setDraggingState: (isDragging: boolean) => void,
    selectedIds: string[],
    shapeRefs: React.MutableRefObject<Record<string, THREE.Group | null>>,
    setAlignmentLines: (lines: AlignmentLine[]) => void,
    setSnapInfo: (snap: SnapResult | null) => void,
    setMeasurement: (val: string) => void,
    guideLines: IGuideLine[] = []
) => {
    const { camera, gl } = useThree();
    const groupRef = useRef<THREE.Group>(null);
    const dragInfo = useRef({
        startPoint: new THREE.Vector3(),
        basePoint: new THREE.Vector3(),
        originalPositions: {} as Record<string, THREE.Vector3>,
        isDragging: false,
        otherBounds: [] as { id: string, bounds: any }[]
    });
    const lastDragMoveTime = useRef(0);

    // Use refs for frequently changing data to keep handlers stable
    const shapesRef = useRef(shapes);
    const selectedIdsRef = useRef(selectedIds);
    const guideLinesRef = useRef(guideLines);

    useEffect(() => {
        shapesRef.current = shapes;
        selectedIdsRef.current = selectedIds;
        guideLinesRef.current = guideLines;
    }, [shapes, selectedIds, guideLines]);

    const getGroundIntersection = useCallback((clientX: number, clientY: number) => {
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const raycaster = new THREE.Raycaster();
        const ndc = new THREE.Vector2(
            (clientX / gl.domElement.clientWidth) * 2 - 1, 
            -(clientY / gl.domElement.clientHeight) * 2 + 1
        );
        raycaster.setFromCamera(ndc, camera);
        const target = new THREE.Vector3();
        const hit = raycaster.ray.intersectPlane(plane, target);
        return hit ? target : null;
    }, [camera, gl]);

    const handlePointerMove = useCallback((e: PointerEvent) => {
        if (!dragInfo.current.isDragging) return;
        // Throttle to ~60fps — pointermove fires 200+/sec
        const now = performance.now();
        if (now - lastDragMoveTime.current < 14) return;
        lastDragMoveTime.current = now;

        // Simple ground-plane intersection — no cross-shape raycast during drag
        const raycaster = new THREE.Raycaster();
        const ndc = new THREE.Vector2(
            (e.clientX / gl.domElement.clientWidth) * 2 - 1,
            -(e.clientY / gl.domElement.clientHeight) * 2 + 1
        );
        raycaster.setFromCamera(ndc, camera);
        const groundY = dragInfo.current.basePoint.y;
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundY);
        const groundIntersect = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(plane, groundIntersect)) return;

        const myOriginalPos = dragInfo.current.originalPositions[shape.id];
        if (!myOriginalPos) return;

        const rawDelta = new THREE.Vector3().subVectors(groundIntersect, dragInfo.current.startPoint);
        const targetPos = new THREE.Vector3().addVectors(myOriginalPos, rawDelta);

        // Grid snap + alignment-line snap (uses pre-computed bounds — no raycast)
        let snappedX = Math.round(targetPos.x / SNAP_GRID) * SNAP_GRID;
        let snappedZ = Math.round(targetPos.z / SNAP_GRID) * SNAP_GRID;
        const newLines: AlignmentLine[] = [];
        const myBoundsRaw = getShapeBounds(shape, new THREE.Vector3(targetPos.x, myOriginalPos.y, targetPos.z));

        let bestXDist = 0.05, bestZDist = 0.05;
        let bestXVal: number | null = null, bestZVal: number | null = null;
        let xMatchLine: AlignmentLine | null = null, zMatchLine: AlignmentLine | null = null;

        for (const { bounds: otherBounds } of dragInfo.current.otherBounds) {
            const xSources = [myBoundsRaw.centerX, myBoundsRaw.minX, myBoundsRaw.maxX];
            const xTargets = [otherBounds.centerX, otherBounds.minX, otherBounds.maxX];
            for (const src of xSources) {
                for (const tgt of xTargets) {
                    const dist = Math.abs(src - tgt);
                    if (dist < bestXDist) {
                        bestXDist = dist; bestXVal = targetPos.x - (src - tgt);
                        xMatchLine = [new THREE.Vector3(tgt, 0, Math.min(myBoundsRaw.minZ, otherBounds.minZ) - 1), new THREE.Vector3(tgt, 0, Math.max(myBoundsRaw.maxZ, otherBounds.maxZ) + 1)];
                    }
                }
            }
            const zSources = [myBoundsRaw.centerZ, myBoundsRaw.minZ, myBoundsRaw.maxZ];
            const zTargets = [otherBounds.centerZ, otherBounds.minZ, otherBounds.maxZ];
            for (const src of zSources) {
                for (const tgt of zTargets) {
                    const dist = Math.abs(src - tgt);
                    if (dist < bestZDist) {
                        bestZDist = dist; bestZVal = targetPos.z - (src - tgt);
                        zMatchLine = [new THREE.Vector3(Math.min(myBoundsRaw.minX, otherBounds.minX) - 1, 0, tgt), new THREE.Vector3(Math.max(myBoundsRaw.maxX, otherBounds.maxX) + 1, 0, tgt)];
                    }
                }
            }
        }
        if (bestXVal !== null) { snappedX = bestXVal; if (xMatchLine) newLines.push(xMatchLine); }
        if (bestZVal !== null) { snappedZ = bestZVal; if (zMatchLine) newLines.push(zMatchLine); }

        const snappedPos = new THREE.Vector3(snappedX, myOriginalPos.y, snappedZ);
        const targetBasePos = dragInfo.current.basePoint.clone().add(new THREE.Vector3().subVectors(snappedPos, myOriginalPos));
        const effectiveDelta = new THREE.Vector3().subVectors(targetBasePos, dragInfo.current.basePoint);

        setAlignmentLines(newLines);
        Object.entries(dragInfo.current.originalPositions).forEach(([id, origPos]) => {
            const ref = shapeRefs.current[id];
            if (ref) ref.position.copy(origPos).add(effectiveDelta);
        });
    }, [camera, gl, shapeRefs, setAlignmentLines, shape.id]);

    const handlePointerUp = useCallback((e: PointerEvent) => {
        if (!dragInfo.current.isDragging) return;
        document.body.style.cursor = 'default';
        dragInfo.current.isDragging = false;
        setDraggingState(false);
        setAlignmentLines([]);
        setSnapInfo(null);
        setMeasurement('');
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
        
        const updates = Object.keys(dragInfo.current.originalPositions).map(id => {
            const ref = shapeRefs.current[id];
            if (ref) { 
                return { 
                    id, 
                    changes: { position: [ref.position.x, ref.position.y, ref.position.z] as [number, number, number] } 
                }; 
            }
            return null;
        }).filter(Boolean) as { id: string, changes: Partial<IShape> }[];
        
        if (updates.length > 0) updateShapes(updates);
    }, [handlePointerMove, updateShapes, setDraggingState, setAlignmentLines, shapeRefs, setSnapInfo, setMeasurement, gl]);

    const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
        if (tool !== ToolType.SELECT || e.button !== 0) return;
        e.stopPropagation();
        const intersect = getGroundIntersection(e.clientX, e.clientY);
        if (intersect) {
            dragInfo.current.isDragging = true;
            lastDragMoveTime.current = 0;
            dragInfo.current.startPoint.copy(intersect);
            
            let idsToMove: string[] = [];
            const currentShapes = shapesRef.current;
            const currentSelectedIds = selectedIdsRef.current;

            if (isSelected) {
                idsToMove = [...currentSelectedIds];
            } else {
                if (shape.groupId) {
                    idsToMove = currentShapes.filter(s => s.groupId === shape.groupId).map(s => s.id);
                } else {
                    idsToMove = [shape.id];
                }
            }
            
            if (!idsToMove.includes(shape.id)) idsToMove.push(shape.id);
            
            // Add all children recursively
            let added = true;
            while (added) {
                added = false;
                for (const s of currentShapes) {
                    if (s.parentId && idsToMove.includes(s.parentId) && !idsToMove.includes(s.id)) {
                        idsToMove.push(s.id);
                        added = true;
                    }
                }
            }
            
            // Pre-calculate other shape bounds for snapping performance
            const idsToMoveSet = new Set(idsToMove);
            dragInfo.current.otherBounds = currentShapes
                .filter(s => !idsToMoveSet.has(s.id) && s.position)
                .map(s => ({ id: s.id, bounds: getShapeBounds(s) }));

            // Determine base point for snapping
            const raycaster = new THREE.Raycaster();
            const ndc = new THREE.Vector2(
                (e.clientX / gl.domElement.clientWidth) * 2 - 1, 
                -(e.clientY / gl.domElement.clientHeight) * 2 + 1
            );
            raycaster.setFromCamera(ndc, camera);
            
            const selectedShapesData = currentShapes.filter(s => idsToMoveSet.has(s.id));
            const snapResult = getGeometrySnap(e.point, raycaster.ray, selectedShapesData, [], SNAP_THRESHOLD);
            
            if (snapResult.type !== 'none' && snapResult.type !== 'grid') {
                dragInfo.current.basePoint.copy(snapResult.position);
                setMeasurement(`已選擇基準點: ${snapResult.type}`);
            } else {
                dragInfo.current.basePoint.copy(e.point);
                setMeasurement('已選擇基準點');
            }

            const origins: Record<string, THREE.Vector3> = {};
            idsToMove.forEach(id => { 
                const ref = shapeRefs.current[id]; 
                if (ref) origins[id] = ref.position.clone(); 
            });
            
            dragInfo.current.originalPositions = origins;
            document.body.style.cursor = 'move';
            setDraggingState(true);
            window.addEventListener('pointermove', handlePointerMove);
            window.addEventListener('pointerup', handlePointerUp);
            window.addEventListener('pointercancel', handlePointerUp);
        }
    }, [tool, shape.id, shape.groupId, getGroundIntersection, handlePointerMove, handlePointerUp, setDraggingState, isSelected, shapeRefs, camera, gl, setMeasurement]);

    useEffect(() => {
        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', handlePointerUp);
        };
    }, [handlePointerMove, handlePointerUp]);

    return { groupRef, handlePointerDown, basePoint: dragInfo.current.isDragging ? dragInfo.current.basePoint : null };
};

// --- Door shape renderer (2D floor-plan symbol) ---
interface DoorShapeItemProps {
    shape: IShape;
    isSelected: boolean;
    tool: ToolType;
    shapes: IShape[];
    updateShapes: (updates: { id: string; changes: Partial<IShape> }[]) => void;
    setDraggingState: (v: boolean) => void;
    selectedIds: string[];
    shapeRefs: React.MutableRefObject<Record<string, THREE.Group | null>>;
    setAlignmentLines: (lines: AlignmentLine[]) => void;
    setSnapInfo: (snap: SnapResult | null) => void;
    setMeasurement: (m: string | null) => void;
    onShapeRef: (id: string, ref: THREE.Group | null) => void;
    selectShape: (id: string, multi?: boolean) => void;
    removeShape: (id: string) => void;
    rotateHandlers: { handleClick: (e: ThreeEvent<MouseEvent>) => void };
    guideLines: IGuideLine[];
}

const DoorShapeItem: React.FC<DoorShapeItemProps> = ({
    shape, isSelected, tool, shapes, updateShapes, setDraggingState,
    selectedIds, shapeRefs, setAlignmentLines, setSnapInfo, setMeasurement,
    onShapeRef, selectShape, removeShape, rotateHandlers, guideLines,
}) => {
    const direction = shape.doorDirection ?? 'left';
    const flipped   = shape.doorFlipped ?? false;
    const color     = isSelected ? '#3b82f6' : (shape.color || '#1e293b');

    const { groupRef, handlePointerDown } = useShapeDrag(
        shape, shapes, isSelected, tool, updateShapes, setDraggingState,
        selectedIds, shapeRefs, setAlignmentLines, setSnapInfo, setMeasurement, guideLines
    );

    useLayoutEffect(() => {
        onShapeRef(shape.id, groupRef.current);
        return () => onShapeRef(shape.id, null);
    }, [onShapeRef, shape.id]);

    const handleSelect = useCallback((e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        selectShape(shape.id, e.nativeEvent.ctrlKey || e.nativeEvent.metaKey || e.nativeEvent.shiftKey);
    }, [selectShape, shape.id]);

    const xMul = direction === 'right' ? -1 : 1;
    const zMul = flipped ? -1 : 1;

    // Quarter-circle arc (unit radius, in XZ plane)
    const arcPoints = useMemo(() => {
        const pts: THREE.Vector3[] = [];
        const N = 48;
        for (let i = 0; i <= N; i++) {
            const a = (i / N) * (Math.PI / 2);
            pts.push(new THREE.Vector3(xMul * Math.cos(a), 0.002, zMul * Math.sin(a)));
        }
        return pts;
    }, [xMul, zMul]);

    // Door panel (hinge to free end)
    const panelPoints = useMemo(() => [
        new THREE.Vector3(0,           0.002, 0),
        new THREE.Vector3(xMul * 1.0, 0.002, 0),
    ], [xMul]);

    // Frame ticks at each jamb
    const tick = 0.1;
    const frameA = useMemo(() => [
        new THREE.Vector3(0,    0.002, -tick * 0.4 * zMul),
        new THREE.Vector3(0,    0.002,  tick        * zMul),
    ], [zMul]);
    const frameB = useMemo(() => [
        new THREE.Vector3(xMul, 0.002, -tick * 0.4 * zMul),
        new THREE.Vector3(xMul, 0.002,  tick        * zMul),
    ], [xMul, zMul]);

    return (
        <group
            ref={groupRef}
            position={shape.position || [0, 0, 0]}
            rotation={shape.rotation || [0, 0, 0]}
            scale={[shape.scale[0], 1, shape.scale[0]]}
            onClick={(e) => { if (tool === ToolType.SELECT || tool === ToolType.SCALE) handleSelect(e); }}
            onPointerDown={(e) => {
                if (tool === ToolType.ERASER) { e.stopPropagation(); removeShape(shape.id); return; }
                else if (tool === ToolType.SELECT) { if (!isSelected) handleSelect(e); handlePointerDown(e); }
                else if (tool === ToolType.ROTATE) rotateHandlers.handleClick(e);
            }}
        >
            {/* Arc */}
            <SimpleLine points={arcPoints} color={color} />
            {/* Door panel */}
            <SimpleLine points={panelPoints} color={color} lineWidth={2} />
            {/* Frame ticks */}
            <SimpleLine points={frameA} color={color} />
            <SimpleLine points={frameB} color={color} />
            {/* Invisible hit-area for picking (lines alone are hard to click) */}
            <mesh position={[xMul * 0.5, 0, zMul * 0.25]}
                  rotation={[0, 0, 0]}>
                <boxGeometry args={[1.05, 0.05, 0.6]} />
                <meshBasicMaterial transparent opacity={0} />
            </mesh>
        </group>
    );
};

// --- Image shape renderer (separate component so texture hooks run unconditionally) ---
interface ImageShapeItemProps {
    shape: IShape;
    isSelected: boolean;
    tool: ToolType;
    shapes: IShape[];
    updateShapes: (updates: { id: string; changes: Partial<IShape> }[]) => void;
    setDraggingState: (v: boolean) => void;
    selectedIds: string[];
    shapeRefs: React.MutableRefObject<Record<string, THREE.Group | null>>;
    setAlignmentLines: (lines: AlignmentLine[]) => void;
    setSnapInfo: (snap: SnapResult | null) => void;
    setMeasurement: (m: string | null) => void;
    onShapeRef: (id: string, ref: THREE.Group | null) => void;
    selectShape: (id: string, multi?: boolean) => void;
    removeShape: (id: string) => void;
    rotateHandlers: { handleClick: (e: ThreeEvent<MouseEvent>) => void };
    guideLines: IGuideLine[];
}

const ImageShapeItem: React.FC<ImageShapeItemProps> = ({
    shape, isSelected, tool, shapes, updateShapes, setDraggingState,
    selectedIds, shapeRefs, setAlignmentLines, setSnapInfo, setMeasurement,
    onShapeRef, selectShape, removeShape, rotateHandlers, guideLines,
}) => {
    const textureLoader = useMemo(() => new THREE.TextureLoader(), []);
    const [texture, setTexture] = useState<THREE.Texture | null>(null);
    const currentTextureRef = useRef<THREE.Texture | null>(null);

    useEffect(() => {
        let cancelled = false;
        if (shape.imageUrl) {
            textureLoader.load(shape.imageUrl, (tex) => {
                if (cancelled) { tex.dispose(); return; }
                tex.colorSpace = THREE.SRGBColorSpace;
                if (currentTextureRef.current) currentTextureRef.current.dispose();
                currentTextureRef.current = tex;
                setTexture(tex);
            });
        } else {
            if (currentTextureRef.current) { currentTextureRef.current.dispose(); currentTextureRef.current = null; }
            setTexture(null);
        }
        return () => { cancelled = true; };
    }, [shape.imageUrl, textureLoader]);

    useEffect(() => {
        return () => {
            if (currentTextureRef.current) { currentTextureRef.current.dispose(); currentTextureRef.current = null; }
        };
    }, []);

    const { groupRef, handlePointerDown } = useShapeDrag(
        shape, shapes, isSelected, tool, updateShapes, setDraggingState,
        selectedIds, shapeRefs, setAlignmentLines, setSnapInfo, setMeasurement, guideLines
    );

    useLayoutEffect(() => {
        onShapeRef(shape.id, groupRef.current);
        return () => onShapeRef(shape.id, null);
    }, [onShapeRef, shape.id]);

    const handleSelect = useCallback((e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        selectShape(shape.id, e.nativeEvent.ctrlKey || e.nativeEvent.metaKey || e.nativeEvent.shiftKey);
    }, [selectShape, shape.id]);

    return (
        <group
            ref={groupRef}
            position={shape.position || [0, 0.001, 0]}
            rotation={shape.rotation || [-Math.PI / 2, 0, 0]}
            scale={shape.scale || [1, 1, 1]}
            onClick={(e) => { if (tool === ToolType.SELECT || tool === ToolType.SCALE) handleSelect(e); }}
            onPointerDown={(e) => {
                if (tool === ToolType.ERASER) return;
                else if (tool === ToolType.SELECT) { if (!isSelected) handleSelect(e); handlePointerDown(e); }
                else if (tool === ToolType.ROTATE) rotateHandlers.handleClick(e);
            }}
        >
            <mesh>
                <planeGeometry args={[1, 1]} />
                <meshBasicMaterial
                    map={texture ?? undefined}
                    transparent
                    side={THREE.DoubleSide}
                    color={texture ? '#ffffff' : shape.color}
                    opacity={shape.opacity ?? 1}
                />
            </mesh>
            {isSelected && (
                <mesh>
                    <planeGeometry args={[1, 1]} />
                    <meshBasicMaterial
                        color="#3b82f6"
                        wireframe
                        transparent
                        opacity={0.5}
                        side={THREE.DoubleSide}
                        depthTest={false}
                    />
                </mesh>
            )}
        </group>
    );
};

const WideLineSegment: React.FC<{
    p1: THREE.Vector3; p2: THREE.Vector3; halfWidth: number;
    color: string; isSelected: boolean;
}> = ({ p1, p2, halfWidth, color, isSelected }) => {
    const geometry = useMemo(() => {
        const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
        const normal = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
        const offset = normal.clone().multiplyScalar(halfWidth);
        const c1 = p1.clone().add(offset);
        const c2 = p2.clone().add(offset);
        const c3 = p2.clone().sub(offset);
        const c4 = p1.clone().sub(offset);
        const path = new THREE.Path();
        path.moveTo(c1.x, -c1.z);
        path.lineTo(c2.x, -c2.z);
        path.lineTo(c3.x, -c3.z);
        path.lineTo(c4.x, -c4.z);
        path.lineTo(c1.x, -c1.z);
        const shape2D = new THREE.Shape(path.getPoints());
        return new THREE.ShapeGeometry(shape2D);
    }, [p1, p2, halfWidth]);

    useEffect(() => {
        return () => { geometry.dispose(); };
    }, [geometry]);

    return (
        <group>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
                <primitive object={geometry} attach="geometry" />
                <meshStandardMaterial
                    color={color}
                    side={THREE.DoubleSide}
                    emissive={isSelected ? '#3b82f6' : '#000000'}
                    emissiveIntensity={isSelected ? 0.2 : 0}
                />
            </mesh>
            <lineSegments rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.011, 0]}>
                <edgesGeometry args={[geometry]} />
                <lineBasicMaterial color={isSelected ? '#3b82f6' : '#333'} />
            </lineSegments>
        </group>
    );
};

interface TextShapeItemProps {
    shape: IShape;
    isSelected: boolean;
    tool: ToolType;
    shapes: IShape[];
    updateShapes: (updates: { id: string; changes: Partial<IShape> }[]) => void;
    setDraggingState: (v: boolean) => void;
    selectedIds: string[];
    shapeRefs: React.MutableRefObject<Record<string, THREE.Group | null>>;
    setAlignmentLines: (lines: AlignmentLine[]) => void;
    setSnapInfo: (snap: SnapResult | null) => void;
    setMeasurement: (val: string) => void;
    onShapeRef: (id: string, ref: THREE.Group | null) => void;
    selectShape: (id: string, multi?: boolean) => void;
    removeShape: (id: string) => void;
    rotateHandlers: { handleClick: (e: ThreeEvent<MouseEvent>) => void };
    guideLines: IGuideLine[];
}

const TextShapeItem: React.FC<TextShapeItemProps> = ({
    shape, isSelected, tool, shapes, updateShapes, setDraggingState,
    selectedIds, shapeRefs, setAlignmentLines, setSnapInfo, setMeasurement,
    onShapeRef, selectShape, removeShape, rotateHandlers, guideLines,
}) => {
    const { groupRef, handlePointerDown, basePoint } = useShapeDrag(
        shape, shapes, isSelected, tool, updateShapes, setDraggingState,
        selectedIds, shapeRefs, setAlignmentLines, setSnapInfo, setMeasurement, guideLines
    );
    useLayoutEffect(() => {
        onShapeRef(shape.id, groupRef.current);
        return () => onShapeRef(shape.id, null);
    }, [onShapeRef, shape.id]);
    const handleSelect = useCallback((e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        selectShape(shape.id, e.nativeEvent.ctrlKey || e.nativeEvent.metaKey || e.nativeEvent.shiftKey);
    }, [selectShape, shape.id]);

    return (
        <group
            ref={groupRef}
            position={shape.position || [0,0,0]}
            rotation={shape.rotation || [0,0,0]}
            scale={shape.scale || [1,1,1]}
            onClick={(e) => { if (tool === ToolType.SELECT || tool === ToolType.SCALE) handleSelect(e); }}
            onPointerDown={(e) => {
                if (tool === ToolType.ERASER) return;
                else if (tool === ToolType.SELECT) { if (!isSelected) handleSelect(e); handlePointerDown(e); }
                else if (tool === ToolType.ROTATE) rotateHandlers.handleClick(e);
            }}
        >
            {basePoint && (
                <mesh position={[basePoint.x - (shape.position?.[0] || 0), basePoint.y - (shape.position?.[1] || 0), basePoint.z - (shape.position?.[2] || 0)]}>
                    <sphereGeometry args={[0.03, 16, 16]} />
                    <meshBasicMaterial color="#ff0000" transparent opacity={0.6} depthTest={false} />
                </mesh>
            )}
            <Text
                fontSize={shape.fontSize || 0.5}
                color={shape.color}
                anchorX="center"
                anchorY="middle"
                outlineWidth={isSelected ? 0.02 : 0}
                outlineColor="#3b82f6"
            >
                {shape.content || 'Text'}
            </Text>
        </group>
    );
};

interface LineShapeItemProps {
    shape: IShape;
    isSelected: boolean;
    tool: ToolType;
    shapes: IShape[];
    updateShapes: (updates: { id: string; changes: Partial<IShape> }[]) => void;
    setDraggingState: (v: boolean) => void;
    selectedIds: string[];
    shapeRefs: React.MutableRefObject<Record<string, THREE.Group | null>>;
    setAlignmentLines: (lines: AlignmentLine[]) => void;
    setSnapInfo: (snap: SnapResult | null) => void;
    setMeasurement: (val: string) => void;
    onShapeRef: (id: string, ref: THREE.Group | null) => void;
    selectShape: (id: string, multi?: boolean) => void;
    removeShape: (id: string) => void;
    rotateHandlers: { handleClick: (e: ThreeEvent<MouseEvent>) => void };
    guideLines: IGuideLine[];
}

const LineShapeItem: React.FC<LineShapeItemProps> = ({
    shape, isSelected, tool, shapes, updateShapes, setDraggingState,
    selectedIds, shapeRefs, setAlignmentLines, setSnapInfo, setMeasurement,
    onShapeRef, selectShape, removeShape, rotateHandlers, guideLines,
}) => {
    const { groupRef, handlePointerDown } = useShapeDrag(
        shape, shapes, isSelected, tool, updateShapes, setDraggingState,
        selectedIds, shapeRefs, setAlignmentLines, setSnapInfo, setMeasurement
    );
    useLayoutEffect(() => {
        onShapeRef(shape.id, groupRef.current);
        return () => onShapeRef(shape.id, null);
    }, [onShapeRef, shape.id]);
    const handleSelect = useCallback((e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        selectShape(shape.id, e.nativeEvent.ctrlKey || e.nativeEvent.metaKey || e.nativeEvent.shiftKey);
    }, [selectShape, shape.id]);

    if (shape.points.length < 2) return null;

    const points = shape.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
    const position = shape.position || [0,0,0];
    const rotation = shape.rotation || [0,0,0];
    const scale = shape.scale || [1,1,1];

    if (shape.lineWidth && shape.lineWidth > 0) {
        const halfWidth = shape.lineWidth / 2;
        return (
            <group
                ref={groupRef} position={position} rotation={rotation} scale={scale}
                onClick={(e) => { if (tool === ToolType.SELECT || tool === ToolType.SCALE) handleSelect(e); }}
                onPointerDown={(e) => {
                    if (tool === ToolType.ERASER) return;
                    else if (tool === ToolType.SELECT) { if (!isSelected) handleSelect(e); handlePointerDown(e); }
                    else if (tool === ToolType.ROTATE) rotateHandlers.handleClick(e);
                }}
            >
                {points.map((p, i) => {
                    if (i === 0) return null;
                    return (
                        <WideLineSegment key={i} p1={points[i - 1]} p2={p} halfWidth={halfWidth}
                            color={shape.color || '#cccccc'} isSelected={isSelected} />
                    );
                })}
                {points.map((p, i) => {
                    if (i === 0 || i === points.length - 1) return null;
                    return (
                        <mesh key={`joint-${i}`} rotation={[-Math.PI / 2, 0, 0]} position={[p.x, 0.01, p.z]}>
                            <circleGeometry args={[halfWidth, 16]} />
                            <meshStandardMaterial color={shape.color || '#cccccc'} side={THREE.DoubleSide}
                                emissive={isSelected ? '#3b82f6' : '#000000'} emissiveIntensity={isSelected ? 0.2 : 0} />
                        </mesh>
                    );
                })}
            </group>
        );
    }

    return (
        <group
            ref={groupRef} position={position} rotation={rotation} scale={scale}
            onClick={(e) => { if (tool === ToolType.SELECT || tool === ToolType.SCALE) handleSelect(e); }}
            onPointerDown={(e) => {
                if (tool === ToolType.ERASER) return;
                else if (tool === ToolType.SELECT) { if (!isSelected) handleSelect(e); handlePointerDown(e); }
                else if (tool === ToolType.ROTATE) rotateHandlers.handleClick(e);
            }}
        >
            <SimpleLine points={points} color={isSelected ? '#3b82f6' : 'black'} lineWidth={2} />
        </group>
    );
};

const ShapeRenderer = React.memo(({
    shape, isSelected, isDraggingTop, dragScaleY, pushPullHandlers, drawingHandlers,
    rotateHandlers, setDraggingState, onShapeRef, shapeRefs, setAlignmentLines,
    setSnapInfo, setMeasurement, isSnapHovered,
    unit, tool, updateShapes, layers, selectedIds, shapes, selectShape, updateShape, removeShape, guideLines
}: ShapeRendererProps) => {
    const { decomposeFlat } = useApp();

    // Unified eraser action: flat shapes decompose into lines; all others are removed.
    const handleEraserAction = useCallback((target: IShape) => {
        if (target.type === 'flat') {
            blockErasedPolygon(target);
            decomposeFlat(target.id);
        } else {
            removeShape(target.id);
        }
    }, [decomposeFlat, removeShape]);

    const handleSelect = useCallback((e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        const isMulti = e.nativeEvent.ctrlKey || e.nativeEvent.metaKey || e.nativeEvent.shiftKey;
        selectShape(shape.id, isMulti);
    }, [selectShape, shape.id]);

    const dimensionSelect = useCallback((e: ThreeEvent<MouseEvent>) => {
        if (!isSelected) {
             e.stopPropagation();
             selectShape(shape.id, e.nativeEvent.ctrlKey || e.nativeEvent.metaKey || e.nativeEvent.shiftKey);
        }
    }, [isSelected, selectShape, shape.id]);

    if (shape.type === 'image') {
        return (
            <ImageShapeItem
                shape={shape}
                isSelected={isSelected}
                tool={tool}
                shapes={shapes}
                updateShapes={updateShapes}
                setDraggingState={setDraggingState}
                selectedIds={selectedIds}
                shapeRefs={shapeRefs}
                setAlignmentLines={setAlignmentLines}
                setSnapInfo={setSnapInfo}
                setMeasurement={setMeasurement}
                onShapeRef={onShapeRef}
                selectShape={selectShape}
                removeShape={removeShape}
                rotateHandlers={rotateHandlers}
                guideLines={guideLines}
            />
        );
    }

    if (shape.type === 'door') {
        return (
            <DoorShapeItem
                shape={shape}
                isSelected={isSelected}
                tool={tool}
                shapes={shapes}
                updateShapes={updateShapes}
                setDraggingState={setDraggingState}
                selectedIds={selectedIds}
                shapeRefs={shapeRefs}
                setAlignmentLines={setAlignmentLines}
                setSnapInfo={setSnapInfo}
                setMeasurement={setMeasurement}
                onShapeRef={onShapeRef}
                selectShape={selectShape}
                removeShape={removeShape}
                rotateHandlers={rotateHandlers}
                guideLines={guideLines}
            />
        );
    }

    const isHole = shape.parentId && shape.height < 0;

    if (shape.type === 'dimension') {
        return <DimensionShape shape={shape} isSelected={isSelected} onSelect={dimensionSelect} />; 
    }

    if (shape.type === 'text') {
        return (
            <TextShapeItem
                shape={shape} isSelected={isSelected} tool={tool} shapes={shapes}
                updateShapes={updateShapes} setDraggingState={setDraggingState}
                selectedIds={selectedIds} shapeRefs={shapeRefs}
                setAlignmentLines={setAlignmentLines} setSnapInfo={setSnapInfo}
                setMeasurement={setMeasurement} onShapeRef={onShapeRef}
                selectShape={selectShape} removeShape={removeShape}
                rotateHandlers={rotateHandlers} guideLines={guideLines}
            />
        );
    }
    
    if (shape.type === 'line') {
        return (
            <LineShapeItem
                shape={shape} isSelected={isSelected} tool={tool} shapes={shapes}
                updateShapes={updateShapes} setDraggingState={setDraggingState}
                selectedIds={selectedIds} shapeRefs={shapeRefs}
                setAlignmentLines={setAlignmentLines} setSnapInfo={setSnapInfo}
                setMeasurement={setMeasurement} onShapeRef={onShapeRef}
                selectShape={selectShape} removeShape={removeShape}
                rotateHandlers={rotateHandlers} guideLines={guideLines}
            />
        );
    }
    
    if (!shape.points || shape.points.length < 3) return null;
    const isPushPullMode = tool === ToolType.PUSH_PULL;
    const isHovered = isSnapHovered && tool !== ToolType.SELECT && tool !== ToolType.PUSH_PULL && tool !== ToolType.ROTATE;
    const highlightColor = isHovered ? '#b0d0ff' : shape.color;
    const edgeColor = isSelected ? '#3b82f6' : (isHovered ? '#0055ff' : '#333');
    const emissiveColor = isSelected ? '#3b82f6' : (isHovered ? '#4466aa' : '#000000');
    const emissiveIntensity = isSelected ? 0.2 : (isHovered ? 0.2 : 0);
    const { groupRef, handlePointerDown, basePoint } = useShapeDrag(
        shape, shapes, isSelected, tool, updateShapes, setDraggingState, 
        selectedIds, shapeRefs, setAlignmentLines, setSnapInfo, setMeasurement
    );
    useLayoutEffect(() => { 
        onShapeRef(shape.id, groupRef.current); 
        return () => onShapeRef(shape.id, null); 
    }, [onShapeRef, shape.id]);

    let scaleY = 1;
    if (isDraggingTop && dragScaleY !== undefined) scaleY = dragScaleY;
    
    const csgHoles = useMemo(() => shapes.filter(s => s.parentId === shape.id && s.height < 0), [shapes, shape.id]);
    
    const shape2D = useMemo(() => createThreeShape(shape.points, shape.holes), [shape.points, shape.holes]);
    const geometry = useMemo(() => {
        // Use ShapeGeometry (single face) for flat shapes (height=0) to avoid
        // Z-fighting: ExtrudeGeometry with depth=0 creates two coincident faces
        // at the exact same Z position, causing depth-buffer interference (moiré).
        let baseGeo: THREE.BufferGeometry = shape.height === 0
            ? new THREE.ShapeGeometry(shape2D)
            : new THREE.ExtrudeGeometry(shape2D, { depth: shape.height, bevelEnabled: false });
        if (csgHoles.length > 0) {
            const evaluator = new Evaluator();
            let baseBrush = new Brush(baseGeo);
            baseBrush.updateMatrixWorld();
            
            const shapePos = new THREE.Vector3(...(shape.position || [0,0,0]));
            const shapeQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(shape.rotation || [0,0,0])));
            const invShapeQuat = shapeQuat.clone().invert();

            // Compute a penetration depth that always exceeds the solid's maximum extent,
            // so holes fully punch through regardless of how thick the solid becomes.
            const bbox = new THREE.Box3().setFromBufferAttribute(baseGeo.attributes.position as THREE.BufferAttribute);
            const penetrationDepth = bbox.getSize(new THREE.Vector3()).length() + 0.1;

            csgHoles.forEach(hole => {
                const holeShape2D = createThreeShape(hole.points, hole.holes);
                const depth = penetrationDepth;
                const holeGeo = new THREE.ExtrudeGeometry(holeShape2D, { depth, bevelEnabled: false });
                const holeBrush = new Brush(holeGeo);

                const holePos = new THREE.Vector3(...(hole.position || [0,0,0]));
                // Transform hole position to shape's local group space
                const localPos = holePos.clone().sub(shapePos).applyQuaternion(invShapeQuat);

                // Handle hole rotation relative to shape
                const holeQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(hole.rotation || [0,0,0])));
                const localQuat = holeQuat.clone().premultiply(invShapeQuat);

                // Map from group space to geometry space
                const qGeoToGroup = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
                const qGroupToGeo = qGeoToGroup.clone().invert();

                const brushQuat = qGroupToGeo.clone().multiply(localQuat).multiply(qGeoToGroup);
                holeBrush.quaternion.copy(brushQuat);

                const brushPos = localPos.clone().applyQuaternion(qGroupToGeo);
                // Offset the hole backwards by half the penetration depth so it covers the full solid
                const offset = new THREE.Vector3(0, 0, -depth / 2).applyQuaternion(brushQuat);
                brushPos.add(offset);
                holeBrush.position.copy(brushPos);
                
                holeBrush.updateMatrixWorld();
                
                baseBrush = evaluator.evaluate(baseBrush, holeBrush, SUBTRACTION);
            });
            return baseBrush.geometry;
        }
        return baseGeo;
    }, [shape2D, shape.height, csgHoles, shape.position, shape.rotation]);

    // Create a clean geometry for EdgesGeometry to avoid internal triangles
    const customEdgesGeo = useMemo(() => {
        // Helper: build edges from a clean ExtrudeGeometry (no CSG, no artifacts)
        const buildBaseEdges = (srcGeo: THREE.BufferGeometry): { positions: number[]; geo: THREE.EdgesGeometry } => {
            const posOnly = new THREE.BufferGeometry();
            posOnly.setAttribute('position', srcGeo.attributes.position.clone());
            if (srcGeo.index) posOnly.setIndex(srcGeo.index.clone());
            const merged = mergeVertices(posOnly, 1e-4);
            merged.computeVertexNormals();
            const edgesGeo = new THREE.EdgesGeometry(merged, 15);
            const positions = [...(edgesGeo.attributes.position.array as Float32Array)];
            merged.dispose();
            posOnly.dispose();
            return { positions, geo: edgesGeo };
        };

        if (csgHoles.length === 0) {
            // No CSG holes: standard edge detection directly from the mesh geometry.
            const { positions, geo } = buildBaseEdges(geometry);
            geo.dispose();
            const result = new THREE.BufferGeometry();
            result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            return result;
        }

        // CSG holes present: the CSG triangulation creates long thin triangles radiating
        // from hole edges to face corners. Due to floating-point errors these triangles
        // appear non-coplanar and EdgesGeometry shows them as stripes.
        //
        // Fix: build edges from the CLEAN pre-CSG base geometry only (no artifacts,
        // no hole-boundary overlay). Hole-boundary edges on the parent face were
        // removed because they rendered as a floating rectangular frame outline.
        const baseGeoForEdge = new THREE.ExtrudeGeometry(shape2D, { depth: shape.height, bevelEnabled: false });
        const { positions: edgePositions, geo: baseEdgesGeo } = buildBaseEdges(baseGeoForEdge);
        baseGeoForEdge.dispose();
        baseEdgesGeo.dispose();

        const result = new THREE.BufferGeometry();
        result.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
        return result;
    }, [geometry, shape2D, shape.height, csgHoles, shape.position, shape.rotation]);

    // Explicit cleanup for geometry
    useEffect(() => {
        return () => {
            geometry.dispose();
            customEdgesGeo.dispose();
        };
    }, [geometry, customEdgesGeo]);

    const position = shape.position || [0,0,0];
    const rotation = shape.rotation || [0,0,0];
    const scale = shape.scale || [1,1,1];

    return (
        <group 
            ref={groupRef}
            position={position} 
            rotation={rotation} 
            scale={scaleY === 1 ? scale : [scale[0], scale[1] * scaleY, scale[2]]} 
            userData={{ isShape: true, id: shape.id, isContainer: true }} 
            name="shape_group" 
            onPointerDown={(e) => {
                if (tool === ToolType.ERASER) return;
                e.stopPropagation();
                if (isPushPullMode) pushPullHandlers.handlePointerDown(e);
                else if (tool === ToolType.SELECT) { 
                    const isMulti = e.nativeEvent.ctrlKey || e.nativeEvent.metaKey || e.nativeEvent.shiftKey;
                    if (!isSelected || isMulti) {
                        handleSelect(e);
                        if (isMulti && isSelected) return;
                    }
                    handlePointerDown(e); 
                }
                else if (tool === ToolType.ROTATE) rotateHandlers.handleClick(e);
                else if (tool !== ToolType.HAND) drawingHandlers.handlePointerDown(e);
            }}
            onClick={(e) => {
                if (tool === ToolType.SELECT) {
                    e.stopPropagation();
                }
            }}
            onPointerMove={(e) => {
                if (isPushPullMode) pushPullHandlers.handlePointerMove(e);
                else if (tool === ToolType.ROTATE) rotateHandlers.handlePointerMove(e);
                else if (drawingHandlers.handlePointerMove) drawingHandlers.handlePointerMove(e);
            }}
            onPointerUp={(e) => { if (isPushPullMode) pushPullHandlers.handlePointerUp(); else if (tool !== ToolType.HAND) drawingHandlers.handlePointerUp(e); }}
        >
            {basePoint && (
                <mesh position={[basePoint.x - position[0], basePoint.y - position[1], basePoint.z - position[2]]}>
                    <sphereGeometry args={[0.03, 16, 16]} />
                    <meshBasicMaterial color="#ff0000" transparent opacity={0.6} depthTest={false} />
                </mesh>
            )}
            <mesh 
                rotation={[-Math.PI/2, 0, 0]} 
                castShadow={!isHole} 
                receiveShadow={!isHole} 
                userData={{ isShape: true, id: shape.id }}
                geometry={geometry}
            >
                <meshStandardMaterial color={highlightColor} emissive={emissiveColor} emissiveIntensity={emissiveIntensity} transparent={shape.type === 'flat' ? (shape.opacity ?? 0.6) < 1.0 : (shape.opacity !== undefined && shape.opacity < 1.0)} opacity={shape.type === 'flat' ? (shape.opacity ?? 0.6) : (shape.opacity ?? 1.0)} depthWrite={shape.type !== 'flat' || (shape.opacity ?? 0.6) >= 1.0} polygonOffset={shape.type === 'flat' || !!shape.parentId} polygonOffsetFactor={shape.type === 'flat' ? -2 : (shape.parentId ? -1 : 0)} polygonOffsetUnits={shape.type === 'flat' ? -2 : (shape.parentId ? -1 : 0)} visible={!isHole} />
                {!isPushPullMode && !isHole && (
                    <lineSegments raycast={() => null} geometry={customEdgesGeo}>
                        <lineBasicMaterial color={edgeColor} toneMapped={false} polygonOffset={!!shape.parentId} polygonOffsetFactor={shape.parentId ? -1 : 0} polygonOffsetUnits={shape.parentId ? -1 : 0} />
                    </lineSegments>
                )}
            </mesh>
        </group>
    );
});

// ... Gizmo & Helper Components ...
const SelectionGizmo: React.FC<{ setDragging: (active: boolean) => void; shapeRefs: React.MutableRefObject<Record<string, THREE.Group | null>>; }> = ({ setDragging, shapeRefs }) => {
    const { selectedIds, transformMode, updateShapes, tool, shapes } = useApp();
    const [dummy] = useState(() => new THREE.Object3D());

    const groupState = useMemo(() => {
        if (selectedIds.length === 0) return null;
        if (selectedIds.length === 1) {
            const id = selectedIds[0];
            const shapeExists = shapes.some(s => s.id === id);
            const targetObj = shapeRefs.current[id];
            if (!shapeExists || !targetObj || !targetObj.parent) return null;
            return { type: 'single', target: targetObj };
        }
        const targets = shapes.filter(s => selectedIds.includes(s.id));
        if (targets.length === 0) return null;
        let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
        targets.forEach(s => {
            const x = s.position[0]; const z = s.position[2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        });
        return {
            type: 'group',
            center: new THREE.Vector3((minX + maxX) / 2, targets[0].position[1], (minZ + maxZ) / 2),
        };
    }, [selectedIds, shapes, shapeRefs]);

    useLayoutEffect(() => {
        if (groupState?.type === 'group' && groupState.center) {
            dummy.position.copy(groupState.center);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrixWorld();
        }
    }, [groupState, dummy]);

    const initialPositions  = useRef<Record<string, THREE.Vector3>>({});
    const initialQuaternions = useRef<Record<string, THREE.Quaternion>>({});
    const initialScales      = useRef<Record<string, THREE.Vector3>>({});
    const startDummyPos      = useRef(new THREE.Vector3());

    // SCALE tool activates this gizmo in 'scale' mode; SELECT tool uses transformMode.
    const isEnabled = (tool === ToolType.SELECT || tool === ToolType.SCALE) && selectedIds.length > 0;
    const activeMode: 'translate' | 'rotate' | 'scale' =
        tool === ToolType.SCALE ? 'scale' : (transformMode as any);

    if (!isEnabled || !groupState) return null;

    /* ── Single object ── */
    if (groupState.type === 'single') {
        if (!groupState.target || !groupState.target.parent) return null;
        return (
            <group>
                <TransformControls
                    object={groupState.target}
                    mode={activeMode}
                    space={activeMode === 'scale' ? 'local' : 'world'}
                    onMouseDown={() => setDragging(true)}
                    onMouseUp={() => {
                        setDragging(false);
                        const t = groupState.target!;
                        updateShapes([{
                            id: selectedIds[0],
                            changes: {
                                position: [t.position.x, t.position.y, t.position.z],
                                rotation: [t.rotation.x, t.rotation.y, t.rotation.z],
                                scale:    [t.scale.x,    t.scale.y,    t.scale.z],
                            }
                        }]);
                    }}
                />
            </group>
        );
    }

    /* ── Multi-object ── */
    return (
        <group>
            <primitive object={dummy} />
            <TransformControls
                object={dummy}
                mode={activeMode}
                space="world"
                onMouseDown={() => {
                    setDragging(true);
                    startDummyPos.current.copy(dummy.position);
                    dummy.rotation.set(0, 0, 0);
                    dummy.scale.set(1, 1, 1);
                    dummy.updateMatrixWorld();
                    const posMap: Record<string, THREE.Vector3>   = {};
                    const quatMap: Record<string, THREE.Quaternion> = {};
                    const scaleMap: Record<string, THREE.Vector3>  = {};
                    selectedIds.forEach(id => {
                        const ref = shapeRefs.current[id];
                        if (ref) {
                            posMap[id]   = ref.position.clone();
                            quatMap[id]  = ref.quaternion.clone();
                            scaleMap[id] = ref.scale.clone();
                        }
                    });
                    initialPositions.current  = posMap;
                    initialQuaternions.current = quatMap;
                    initialScales.current      = scaleMap;
                }}
                onChange={() => {
                    if (activeMode === 'translate') {
                        const delta = new THREE.Vector3().subVectors(dummy.position, startDummyPos.current);
                        selectedIds.forEach(id => {
                            const startPos = initialPositions.current[id];
                            const ref = shapeRefs.current[id];
                            if (startPos && ref) ref.position.copy(startPos).add(delta);
                        });
                    } else if (activeMode === 'rotate') {
                        const deltaQuat = dummy.quaternion.clone();
                        const pivot = startDummyPos.current;
                        selectedIds.forEach(id => {
                            const initPos  = initialPositions.current[id];
                            const initQuat = initialQuaternions.current[id];
                            const ref = shapeRefs.current[id];
                            if (initPos && initQuat && ref) {
                                const vPos = initPos.clone().sub(pivot);
                                vPos.applyQuaternion(deltaQuat);
                                ref.position.copy(pivot).add(vPos);
                                ref.quaternion.copy(deltaQuat).multiply(initQuat);
                            }
                        });
                    } else if (activeMode === 'scale') {
                        // dummy.scale = ratio relative to [1,1,1] (reset on mouseDown)
                        const sx = dummy.scale.x, sy = dummy.scale.y, sz = dummy.scale.z;
                        const pivot = startDummyPos.current;
                        selectedIds.forEach(id => {
                            const initPos   = initialPositions.current[id];
                            const initScale = initialScales.current[id];
                            const ref = shapeRefs.current[id];
                            if (initPos && initScale && ref) {
                                // Scale position away from group centre
                                const vPos = initPos.clone().sub(pivot);
                                vPos.set(vPos.x * sx, vPos.y * sy, vPos.z * sz);
                                ref.position.copy(pivot).add(vPos);
                                // Scale the object itself
                                ref.scale.set(initScale.x * sx, initScale.y * sy, initScale.z * sz);
                            }
                        });
                    }
                }}
                onMouseUp={() => {
                    setDragging(false);
                    const updates = selectedIds.map(id => {
                        const ref = shapeRefs.current[id];
                        if (!ref) return null;
                        return {
                            id,
                            changes: {
                                position: [ref.position.x, ref.position.y, ref.position.z] as [number, number, number],
                                rotation: [ref.rotation.x, ref.rotation.y, ref.rotation.z] as [number, number, number],
                                scale:    [ref.scale.x,    ref.scale.y,    ref.scale.z]    as [number, number, number],
                            }
                        };
                    }).filter(Boolean) as any;
                    if (updates.length > 0) updateShapes(updates);
                }}
            />
        </group>
    );
};

// ... Rest of the file unchanged ...

// (Keep CameraHandler, DrawingPreview, InteractionLayer, usePushPullManager, useRotateManager, useDrawingManager, SceneContent, Viewport)

const CameraHandler: React.FC<{ view: string | null; onFinished: () => void }> = ({ view, onFinished }) => {
    const { camera, controls } = useThree();
    useEffect(() => {
        if (!view) return;
        let targetPos = new THREE.Vector3();
        const DISTANCE = 20;
        switch (view) { case 'top': targetPos.set(0, DISTANCE, 0); break; case 'bottom': targetPos.set(0, -DISTANCE, 0); break; case 'front': targetPos.set(0, 0, DISTANCE); break; case 'back': targetPos.set(0, 0, -DISTANCE); break; case 'right': targetPos.set(DISTANCE, 0, 0); break; case 'left': targetPos.set(-DISTANCE, 0, 0); break; default: return; }
        camera.position.copy(targetPos);
        camera.lookAt(0, 0, 0);
        if (controls) { const c = controls as any; if (c.target && typeof c.target.set === 'function') { c.target.set(0, 0, 0); c.update(); } }
        onFinished();
    }, [view, camera, controls, onFinished]);
    return null;
};

// ... Interaction Layer ...
const DrawingPreview: React.FC<{ tool: ToolType; points: IPoint[]; cursorPos: THREE.Vector3; guideCreating: { active: boolean, start: THREE.Vector3, current: THREE.Vector3, edge: [THREE.Vector3, THREE.Vector3] | null }; drawingNormal: THREE.Vector3 }> = ({ tool, points, cursorPos, guideCreating, drawingNormal }) => {
    const { formatValue } = useApp();
    const currentPoint = cursorPos;
    if (tool === ToolType.GUIDE_LINE && guideCreating.active) {
        if (guideCreating.edge) {
            const p1 = guideCreating.edge[0].clone(); 
            const p2 = guideCreating.edge[1].clone();
            
            const direction = new THREE.Vector3().subVectors(p2, p1).normalize();
            
            const isHorizontalEdge = Math.abs(p1.y - p2.y) < 0.01;
            const drawPos = currentPoint.clone();
            
            if (isHorizontalEdge) {
                drawPos.y = p1.y;
            }

            const v = new THREE.Vector3().subVectors(drawPos, p1);
            const projection = v.dot(direction);
            const projectedPointOnEdgeLine = p1.clone().add(direction.clone().multiplyScalar(projection));
            const rejection = new THREE.Vector3().subVectors(drawPos, projectedPointOnEdgeLine);
            
            drawPos.copy(p1.clone().add(rejection));

            let guideDirection = direction.clone();

            // Render Infinite Ghost Line
            const lineStart = drawPos.clone().add(guideDirection.clone().multiplyScalar(-5000));
            const lineEnd = drawPos.clone().add(guideDirection.clone().multiplyScalar(5000));
            
            // Warning/Alert color: Orange for parallel
            const guideColor = "#f59e0b"; 
            
            return ( 
                <group renderOrder={1000}>
                    <SimpleLine points={[lineStart, lineEnd]} color={guideColor} dashed opacity={0.8} depthTest={false} />
                    <SimpleLine points={[projectedPointOnEdgeLine, drawPos]} color="#ef4444" dashed opacity={0.6} depthTest={false} />
                </group> 
            );
        } else if (tool === ToolType.GUIDE_LINE) {
            const dx = Math.abs(currentPoint.x - guideCreating.start.x);
            const dz = Math.abs(currentPoint.z - guideCreating.start.z);
            let start = guideCreating.start.clone();
            let end = currentPoint.clone();
            // Axis lock visualization
            if (dx > dz) { end.z = start.z; start.x -= 1000; end.x += 1000; } else { end.x = start.x; start.z -= 1000; end.z += 1000; }
             return ( <group renderOrder={1000}><SimpleLine points={[start, end]} color="#f59e0b" dashed opacity={0.6} depthTest={false} /></group> );
        }
    }

    if (tool === ToolType.DIMENSION && points.length > 0) {
        if (points.length === 1 && points[0]) {
            const start = new THREE.Vector3(points[0].x, points[0].y, points[0].z);
            const dist = start.distanceTo(currentPoint);
            return (
                <group>
                    <SimpleLine points={[start, currentPoint]} color="#3b82f6" dashed opacity={0.7} />
                    <DimensionLabel position={new THREE.Vector3().addVectors(start, currentPoint).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.3, 0))} text={formatValue(dist)} color="#3b82f6" />
                </group>
            );
        }
        
        if (points.length === 2 && points[0] && points[1]) {
             const p1 = new THREE.Vector3(points[0].x, points[0].y, points[0].z);
             const p2 = new THREE.Vector3(points[1].x, points[1].y, points[1].z);
             const p3 = currentPoint.clone();

             // PLANE INFERENCE FIX:
             if (Math.abs(p1.y - p2.y) < 0.05) {
                p3.y = p1.y;
             }
             
             const v12 = new THREE.Vector3().subVectors(p2, p1);
             const v13 = new THREE.Vector3().subVectors(p3, p1);
             const lenSq = v12.lengthSq();
             const projectionFactor = lenSq > 0 ? v13.dot(v12) / lenSq : 0;
             const projectedPoint = p1.clone().add(v12.clone().multiplyScalar(projectionFactor));
             
             const offsetVector = new THREE.Vector3().subVectors(p3, projectedPoint);
             
             const dimStart = p1.clone().add(offsetVector);
             const dimEnd = p2.clone().add(offsetVector);
             const midPoint = new THREE.Vector3().addVectors(dimStart, dimEnd).multiplyScalar(0.5);
             
             const GAP_SIZE = 0.05; 
             const offsetDir = offsetVector.clone().normalize();
             const offsetLen = offsetVector.length();
             
             const useGap = offsetLen > GAP_SIZE * 1.5;
             const ext1Start = useGap ? p1.clone().add(offsetDir.clone().multiplyScalar(GAP_SIZE)) : p1;
             const ext2Start = useGap ? p2.clone().add(offsetDir.clone().multiplyScalar(GAP_SIZE)) : p2;
             const color = "#0ea5e9";

             return (
                <group>
                    <SimpleLine points={[dimStart, dimEnd]} color={color} opacity={0.8} />
                    <SimpleLine points={[ext1Start, dimStart]} color="#999" dashed opacity={0.5} />
                    <SimpleLine points={[ext2Start, dimEnd]} color="#999" dashed opacity={0.5} />
                    <mesh position={dimStart}><sphereGeometry args={[0.03]} /><meshBasicMaterial color={color} depthTest={false} /></mesh>
                    <mesh position={dimEnd}><sphereGeometry args={[0.03]} /><meshBasicMaterial color={color} depthTest={false} /></mesh>
                    
                    <DimensionLabel position={midPoint} text={formatValue(p1.distanceTo(p2))} color={color} />
                </group>
             );
        }
    }

    if (points.length === 0) return null;
    const startPoint = points[points.length-1];
    if (!startPoint) return null;
    const startVec = new THREE.Vector3(startPoint.x, startPoint.y, startPoint.z);
    
    if (tool === ToolType.DRAW_LINE) {
        return <SimpleLine points={[startVec, currentPoint]} color="black" dashed depthTest={false} />;
    }

    if (tool === ToolType.DRAW_RECT) {
        const start = points[0];
        if (!start) return null;
        const startV = new THREE.Vector3(start.x, start.y, start.z);
        const { right, top } = getLocalBasis(drawingNormal);
        const diff = new THREE.Vector3().subVectors(currentPoint, startV);
        const w = diff.dot(right);
        const h = diff.dot(top);

        const p1 = startV;
        const p2 = startV.clone().add(right.clone().multiplyScalar(w));
        const p3 = startV.clone().add(right.clone().multiplyScalar(w)).add(top.clone().multiplyScalar(h));
        const p4 = startV.clone().add(top.clone().multiplyScalar(h));
        const rectPoints = [p1, p2, p3, p4, p1];

        // Offset slightly along normal so the preview line is never behind the face
        const normalOffset = drawingNormal.clone().multiplyScalar(0.005);
        const offsetRect = rectPoints.map(p => p.clone().add(normalOffset));

        return (
            <group>
                <SimpleLine points={offsetRect} color="black" dashed depthTest={false} />
            </group>
        );
    }

    if (tool === ToolType.DRAW_CIRCLE) {
        const start = points[0];
        if (!start) return null;
        const startV = new THREE.Vector3(start.x, start.y, start.z);
        const radius = startV.distanceTo(currentPoint);

        // Build circle in the drawing surface's local plane using its basis vectors,
        // then translate to world space. This fixes the bug where the circle preview
        // was always generated in the XZ plane instead of following the face normal.
        const { right, top } = getLocalBasis(drawingNormal);
        const normalOffset = drawingNormal.clone().multiplyScalar(0.005);
        const segments = 48;
        const worldPts: THREE.Vector3[] = [];
        for (let i = 0; i <= segments; i++) {
            const theta = (i / segments) * Math.PI * 2;
            const pt = startV.clone()
                .add(right.clone().multiplyScalar(Math.cos(theta) * radius))
                .add(top.clone().multiplyScalar(Math.sin(theta) * radius))
                .add(normalOffset);
            worldPts.push(pt);
        }

        const radiusEnd = currentPoint.clone().add(normalOffset);

        return (
            <group>
                <SimpleLine points={worldPts} color="black" dashed depthTest={false} />
                <SimpleLine points={[startV.clone().add(normalOffset), radiusEnd]} color="gray" dashed depthTest={false} />
            </group>
        );
    }
    
    return null;
};

const InteractionLayer: React.FC<{
    shapes: IShape[];
    tool: ToolType;
    setCursorPos: (v: THREE.Vector3) => void;
    setSnapInfo: (s: SnapResult | null) => void;
    cursorPos: THREE.Vector3;
    snapInfo: SnapResult | null;
    drawPoints: IPoint[];
    isDragging: boolean;
    drawingHeight: number;
    typedInput: string;
    guideCreating: any;
    rotatePhase: RotatePhase;
    drawingNormal: THREE.Vector3;
    isGizmoDragging: boolean;
    inferenceGuide: InferenceGuide | null;
    setInferenceGuide: (g: InferenceGuide | null) => void;
    onPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
    onPointerUp?: (e: ThreeEvent<PointerEvent>) => void;
    onClick?: (e: ThreeEvent<MouseEvent>) => void;
    onMove?: (e: ThreeEvent<PointerEvent>) => void;
    selectionBox: { start: THREE.Vector2 | null, current: THREE.Vector2 | null };
}> = ({ shapes, tool, setCursorPos, setSnapInfo, cursorPos, snapInfo, drawPoints, isDragging, drawingHeight, typedInput, guideCreating, rotatePhase, drawingNormal, isGizmoDragging, inferenceGuide, setInferenceGuide, onPointerDown, onPointerUp, onClick, onMove, selectionBox }) => {
    const { formatValue, setMeasurement } = useApp();
    const { camera } = useThree();
    const cameraDistance = snapInfo ? camera.position.distanceTo(snapInfo.position) : 5;

    if (tool === ToolType.HAND) return null;

    return (
        <group>
            <mesh 
                rotation={[-Math.PI / 2, 0, 0]} 
                position={[0, -0.001, 0]} 
                onPointerMove={onMove}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onClick={onClick}
                renderOrder={-1}
            >
                <planeGeometry args={[1000, 1000]} />
                <meshBasicMaterial visible={false} depthWrite={false} />
            </mesh>
             {snapInfo && tool !== ToolType.ROTATE && !isGizmoDragging && !selectionBox.start && ( 
                <>
                    <SnapIndicator
                        position={snapInfo.position}
                        type={snapInfo.type}
                        snapEdge={snapInfo.snapEdge}
                        normal={snapInfo.normal}
                        cameraDistance={cameraDistance}
                    />
                    <CursorTooltip text={snapInfo.type === 'none' ? '' : snapInfo.type} position={snapInfo.position} type={snapInfo.type} />
                </> 
            )}
             <InferenceGuideRenderer guide={inferenceGuide} />
             <DrawingPreview tool={tool} points={drawPoints} cursorPos={cursorPos} guideCreating={guideCreating} drawingNormal={drawingNormal} />
        </group>
    );
};

const usePushPullManager = () => {
    const { tool, updateShape, updateShapes, shapes, setMeasurement, formatValue, layers } = useApp();
    const { camera, gl } = useThree();
    const [ppState, setPPState] = useState<PushPullState>({ mode: 'none', hoveredShapeId: null, hoveredEdgeIndex: -1, dragStartPoint: null, originalHeight: 0, originalPoints: [], normal: new THREE.Vector3(0, 1, 0), dragHeight: undefined });
    const ppStateRef = useRef(ppState);
    useEffect(() => { ppStateRef.current = ppState; }, [ppState]);
    const [tempShape, setTempShapeState] = useState<IShape | null>(null);
    const tempShapeRef = useRef<IShape | null>(null);
    const setTempShape = (s: IShape | null) => { tempShapeRef.current = s; setTempShapeState(s); };
    const isDragging = !!ppState.dragStartPoint;
    const identifyFace = useCallback((e: ThreeEvent<PointerEvent>): Partial<PushPullState> | null => {
        const intersections = e.intersections as unknown as THREE.Intersection[];
        if (!intersections || intersections.length === 0) return null;
        
        // Find all valid shape intersections
        const validIntersections = intersections.filter(i => i.face && (i.object.userData?.isShape || i.object.parent?.userData?.isShape));
        if (validIntersections.length === 0) return null;
        
        // Find the closest distance
        const minDist = validIntersections[0].distance;
        
        // Get all intersections within a small epsilon of the closest distance
        const coincidentIntersections = validIntersections.filter(i => Math.abs(i.distance - minDist) < 0.01);
        
        // Prefer holes (shapes with parentId and height < 0)
        let intersection = coincidentIntersections[0];
        for (const i of coincidentIntersections) {
            const obj = i.object.userData?.isShape ? i.object : i.object.parent;
            const shapeId = obj?.userData?.id;
            const shape = shapes.find(s => s.id === shapeId);
            if (shape && shape.parentId && shape.height < 0) {
                intersection = i;
                break;
            }
        }
        
        if (!intersection || !intersection.face) return null;
        
        const object = intersection.object;
        let shapeId: string | null = null;
        if (object.userData?.isShape) shapeId = object.userData.id; else if (object.parent?.userData?.isShape) shapeId = object.parent.userData.id;
        if (!shapeId) return null;
        const shape = shapes.find(s => s.id === shapeId);
        if (!shape) return null;
        const layer = layers.find(l => l.id === shape.layerId);
        if (layer && !layer.visible) return null;
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
        const worldNormal = intersection.face.normal.clone().applyMatrix3(normalMatrix).normalize();
        
        const shapeAxis = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(...(shape.rotation || [0,0,0]))).normalize();
        
        if (worldNormal.dot(shapeAxis) > 0.9) return { mode: 'top', hoveredShapeId: shapeId, hoveredEdgeIndex: -1, normal: shapeAxis };
        if (worldNormal.dot(shapeAxis) < -0.9) return { mode: 'none', hoveredShapeId: null, hoveredEdgeIndex: -1, normal: shapeAxis.clone().negate() }; 
        
        if (Math.abs(worldNormal.dot(shapeAxis)) < 0.2) {
            const hitPoint = intersection.point.clone().sub(new THREE.Vector3(...shape.position));
            const shapeQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...shape.rotation));
            const invQuat = shapeQuat.clone().invert();
            const localPoint = hitPoint.applyQuaternion(invQuat);
            const xLocal = localPoint.x; const zLocal = localPoint.z;
            let closestIndex = -1; let minDistSq = Infinity;
            const pts = shape.points;
            if (!pts) return null;
            for(let i=0; i<pts.length; i++) { 
                const p1 = pts[i]; 
                const p2 = pts[(i+1) % pts.length]; 
                if (!p1 || !p2) continue;
                const unscaledX = xLocal / shape.scale[0]; 
                const unscaledZ = zLocal / shape.scale[2]; 
                const d2 = distToSegmentSquared(new THREE.Vector3(unscaledX, 0, unscaledZ), new THREE.Vector3(p1.x, 0, p1.z), new THREE.Vector3(p2.x, 0, p2.z)); if (d2 < minDistSq) { minDistSq = d2; closestIndex = i; } }
            if (closestIndex !== -1) { 
                const flatNormal = worldNormal.clone().sub(shapeAxis.clone().multiplyScalar(worldNormal.dot(shapeAxis))).normalize();
                return { mode: 'side', hoveredShapeId: shapeId, hoveredEdgeIndex: closestIndex, normal: flatNormal }; 
            }
        }
        return null;
    }, [shapes, layers]);
    const handlePointerMove = useCallback((e: ThreeEvent<PointerEvent>) => {
        const state = ppStateRef.current;
        if (tool !== ToolType.PUSH_PULL) return;
        if (!!state.dragStartPoint) {
            e.stopPropagation();
            if (!state.dragStartPoint || !state.hoveredShapeId) return;
            const shape = shapes.find(s => s.id === state.hoveredShapeId);
            if (!shape) return;
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(new THREE.Vector2((e.clientX / gl.domElement.clientWidth) * 2 - 1, -(e.clientY / gl.domElement.clientHeight) * 2 + 1), camera);
            if (state.mode === 'top') { 
                const axis = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(...(shape.rotation || [0,0,0]))).normalize();
                const camDir = camera.getWorldDirection(new THREE.Vector3());
                let planeNormal = camDir.clone().cross(axis).cross(axis).normalize();
                if (planeNormal.lengthSq() < 0.0001) {
                    const up = new THREE.Vector3(0, 1, 0);
                    if (Math.abs(axis.y) > 0.9) up.set(1, 0, 0);
                    planeNormal = up.cross(axis).cross(axis).normalize();
                }
                const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, state.dragStartPoint);
                const target = new THREE.Vector3();
                const hitTop = raycaster.ray.intersectPlane(dragPlane, target);
                if (hitTop) {
                    const diff = target.clone().sub(state.dragStartPoint);
                    const deltaHeight = diff.dot(axis);
                    let newHeight = state.originalHeight + deltaHeight;
                    if (!shape.parentId) {
                        newHeight = Math.max(0.01, newHeight);
                    }
                    setPPState(prev => ({ ...prev, dragHeight: newHeight }));
                    setMeasurement(`高度: ${formatValue(newHeight)}`);
                }
            } else if (state.mode === 'side') {
                const axis = state.normal.clone().normalize();
                const camDir = camera.getWorldDirection(new THREE.Vector3());
                let planeNormal = camDir.clone().cross(axis).cross(axis).normalize();
                if (planeNormal.lengthSq() < 0.0001) {
                    const up = new THREE.Vector3(0, 1, 0);
                    if (Math.abs(axis.y) > 0.9) up.set(1, 0, 0);
                    planeNormal = up.cross(axis).cross(axis).normalize();
                }
                const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, state.dragStartPoint);
                const target = new THREE.Vector3();
                const hitSide = raycaster.ray.intersectPlane(dragPlane, target);
                if (hitSide) {
                    const diff = target.clone().sub(state.dragStartPoint); 
                    const projection = diff.dot(axis); 
                    const moveVectorWorld = axis.clone().multiplyScalar(projection); 
                    setMeasurement(`偏移: ${formatValue(projection)}`); 
                    const shapeQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...shape.rotation)); 
                    const invQuat = shapeQuat.clone().invert(); 
                    const moveVectorLocal = moveVectorWorld.clone().applyQuaternion(invQuat); 
                    const dLocalX = moveVectorLocal.x / shape.scale[0]; 
                    const dLocalZ = moveVectorLocal.z / shape.scale[2]; 
                    const idx = state.hoveredEdgeIndex; 
                    const newPoints = state.originalPoints.map(p => ({...p})); 
                    const p1 = newPoints[idx]; 
                    const p2 = newPoints[(idx+1) % newPoints.length]; 
                    p1.x += dLocalX; 
                    p1.z += dLocalZ; 
                    p2.x += dLocalX; 
                    p2.z += dLocalZ; 
                    const updatedShape = { ...shape, points: newPoints }; 
                    setTempShape(updatedShape); 
                } 
            }
        } else {
            const res = identifyFace(e);
            if (res) { e.stopPropagation(); document.body.style.cursor = res.mode === 'top' ? 'ns-resize' : 'ew-resize'; setPPState(prev => ({ ...prev, mode: res.mode!, hoveredShapeId: res.hoveredShapeId!, hoveredEdgeIndex: res.hoveredEdgeIndex!, normal: res.normal! })); } 
            else { setPPState(prev => ({ ...prev, mode: 'none', hoveredShapeId: null })); document.body.style.cursor = 'default'; }
        }
    }, [tool, shapes, camera, gl, identifyFace, setMeasurement, formatValue]);
    const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
        const state = ppStateRef.current;
        if (tool !== ToolType.PUSH_PULL || e.button !== 0) return; 
        e.stopPropagation();
        if (state.mode !== 'none' && state.hoveredShapeId) {
             const shape = shapes.find(s => s.id === state.hoveredShapeId);
             if(!shape) return;
             const raycaster = new THREE.Raycaster();
             raycaster.setFromCamera(new THREE.Vector2((e.clientX / gl.domElement.clientWidth) * 2 - 1, -(e.clientY / gl.domElement.clientHeight) * 2 + 1), camera);
             const startPoint = new THREE.Vector3();
             let startHit = false;
             if (state.mode === 'top') {
                 const axis = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(...(shape.rotation || [0,0,0]))).normalize();
                 const camDir = camera.getWorldDirection(new THREE.Vector3());
                 let planeNormal = camDir.clone().cross(axis).cross(axis).normalize();
                 if (planeNormal.lengthSq() < 0.0001) {
                     const up = new THREE.Vector3(0, 1, 0);
                     if (Math.abs(axis.y) > 0.9) up.set(1, 0, 0);
                     planeNormal = up.cross(axis).cross(axis).normalize();
                 }
                 const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, (e as any).point);
                 startHit = raycaster.ray.intersectPlane(plane, startPoint) !== null;
             } else {
                 const axis = state.normal.clone().normalize();
                 const camDir = camera.getWorldDirection(new THREE.Vector3());
                 let planeNormal = camDir.clone().cross(axis).cross(axis).normalize();
                 if (planeNormal.lengthSq() < 0.0001) {
                     const up = new THREE.Vector3(0, 1, 0);
                     if (Math.abs(axis.y) > 0.9) up.set(1, 0, 0);
                     planeNormal = up.cross(axis).cross(axis).normalize();
                 }
                 const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, (e as any).point);
                 startHit = raycaster.ray.intersectPlane(plane, startPoint) !== null;
             }
             if (!startHit) return;
             const originalPoints = shape.points.map(p => ({...p}));
             if (originalPoints.length > 2) {
                 const first = originalPoints[0];
                 const last = originalPoints[originalPoints.length - 1];
                 if (Math.abs(first.x - last.x) < 0.001 && Math.abs(first.z - last.z) < 0.001) {
                     originalPoints.pop();
                 }
             }
             setPPState(prev => ({ 
                 ...prev, 
                 dragStartPoint: startPoint, 
                 originalHeight: shape.height, 
                 dragHeight: shape.height, 
                 originalPoints: originalPoints 
             }));
             if (state.mode === 'side') setTempShape(shape);
        }
    }, [tool, shapes, camera, gl]);
    const handlePointerUp = useCallback(() => {
        const state = ppStateRef.current;
        if (state.mode === 'top' && state.dragHeight !== undefined && state.hoveredShapeId) { 
            const shape = shapes.find(s => s.id === state.hoveredShapeId); 
            const updates: Partial<IShape> = { height: state.dragHeight }; 
            if (shape && shape.type === 'flat' && Math.abs(state.dragHeight) > 0.05) { 
                updates.type = 'solid'; 
                if (shape.color === FLAT_COLOR) updates.color = DEFAULT_COLOR; 
            } 
            updateShape(state.hoveredShapeId, updates); 
        } 
        else if (tempShapeRef.current) {
            const parentId = tempShapeRef.current.id;
            const parentShape = shapes.find(s => s.id === parentId);
            const csgHoles = shapes.filter(s => s.parentId === parentId && s.height < 0);
            if (parentShape && csgHoles.length > 0 && state.originalPoints.length > 0) {
                const idx = state.hoveredEdgeIndex;
                const origP = state.originalPoints[idx];
                const newP = tempShapeRef.current.points[idx];
                const dLocalX = newP.x - origP.x;
                const dLocalZ = newP.z - origP.z;
                // Convert local displacement back to world space
                const shapeQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...parentShape.rotation));
                const invQuat = shapeQuat.clone().invert();
                const localDisp = new THREE.Vector3(dLocalX * parentShape.scale[0], 0, dLocalZ * parentShape.scale[2]);
                localDisp.applyQuaternion(shapeQuat);
                // Determine which holes are on the pushed face by checking proximity to the edge line
                const ep1 = state.originalPoints[idx];
                const ep2 = state.originalPoints[(idx + 1) % state.originalPoints.length];
                const edgeDx = ep2.x - ep1.x;
                const edgeDz = ep2.z - ep1.z;
                const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDz * edgeDz);
                const allUpdates: { id: string; changes: Partial<IShape> }[] = [
                    { id: parentId, changes: { points: tempShapeRef.current.points } }
                ];
                const parentPos = new THREE.Vector3(...parentShape.position);
                for (const hole of csgHoles) {
                    // Convert hole world position to parent's local pre-scale space
                    const holeWorldPos = new THREE.Vector3(...hole.position);
                    const holeLocal = holeWorldPos.clone().sub(parentPos).applyQuaternion(invQuat);
                    const hlx = holeLocal.x / parentShape.scale[0];
                    const hlz = holeLocal.z / parentShape.scale[2];
                    // Distance from hole to the edge line in local XZ
                    const cross = edgeDx * (hlz - ep1.z) - edgeDz * (hlx - ep1.x);
                    const dist = edgeLen > 0.0001 ? Math.abs(cross) / edgeLen : Infinity;
                    if (dist < 0.05) {
                        allUpdates.push({
                            id: hole.id,
                            changes: {
                                position: [
                                    hole.position[0] + localDisp.x,
                                    hole.position[1] + localDisp.y,
                                    hole.position[2] + localDisp.z,
                                ] as [number, number, number]
                            }
                        });
                    }
                }
                updateShapes(allUpdates);
            } else {
                updateShape(parentId, { points: tempShapeRef.current.points });
            }
        }
        setTempShape(null); setPPState(prev => ({ ...prev, dragStartPoint: null, originalPoints: [], dragHeight: undefined })); setMeasurement('');
    }, [updateShape, updateShapes, shapes, setMeasurement]);
    useEffect(() => { if (isDragging) { const onGlobalPointerUp = () => handlePointerUp(); window.addEventListener('pointerup', onGlobalPointerUp); return () => window.removeEventListener('pointerup', onGlobalPointerUp); } }, [isDragging, handlePointerUp]);
    return { ppState, handlePointerMove, handlePointerDown, handlePointerUp, isDragging, tempShape };
};

const useRotateManager = (shapeRefs: React.MutableRefObject<Record<string, THREE.Group | null>>, snapInfo: SnapResult | null) => {
    const { tool, shapes, updateShapes, selectedIds, setMeasurement } = useApp();
    const rotateRef = useRef({
        axisPoint1: null as THREE.Vector3 | null,
        pivot: null as THREE.Vector3 | null,
        axis: new THREE.Vector3(0, 1, 0),
        startVector: null as THREE.Vector3 | null,
        initialTransforms: {} as Record<string, { pos: THREE.Vector3, quat: THREE.Quaternion }>
    });
    const snapInfoRef = useRef(snapInfo);
    useEffect(() => { snapInfoRef.current = snapInfo; }, [snapInfo]);

    const [phase, setPhase] = useState<RotatePhase>('hover');
    const [uiState, setUiState] = useState<{
        pivot: THREE.Vector3 | null;
        axis: THREE.Vector3 | null;
        axisPoint1: THREE.Vector3 | null;
        axisPreviewEnd: THREE.Vector3 | null;
    }>({ pivot: null, axis: null, axisPoint1: null, axisPreviewEnd: null });

    useEffect(() => {
        if (tool !== ToolType.ROTATE) {
            setPhase('hover');
            rotateRef.current = { axisPoint1: null, pivot: null, axis: new THREE.Vector3(0, 1, 0), startVector: null, initialTransforms: {} };
            setUiState({ pivot: null, axis: null, axisPoint1: null, axisPreviewEnd: null });
            setMeasurement('');
        }
    }, [tool, setMeasurement]);

    useEffect(() => {
        if (tool !== ToolType.ROTATE) return;
        if (phase === 'hover')       setMeasurement('旋轉模式：點擊第 1 點（轉軸起點）');
        else if (phase === 'set-axis-end') setMeasurement('旋轉模式：點擊第 2 點（轉軸終點），可鎖定 Shift 吸附方向');
        else if (phase === 'set-start')    setMeasurement('旋轉模式：點擊設定「起始角度參考點」');
    }, [tool, phase, setMeasurement]);

    // Helper: get snapped point from event
    const getSnapPoint = useCallback((e: ThreeEvent<MouseEvent> | ThreeEvent<PointerEvent>): THREE.Vector3 => {
        const snap = snapInfoRef.current;
        if (snap && snap.type !== 'none' && snap.type !== 'grid') return snap.position.clone();
        const intersection = (e.intersections as unknown as THREE.Intersection[]).find(
            i => i.face && (i.object.userData?.isShape || i.object.parent?.userData?.isShape)
        );
        return intersection ? intersection.point.clone() : e.point.clone();
    }, []);

    // Helper: build initial transforms for selected shapes
    const buildInitials = useCallback(() => {
        let idsToRotate = [...selectedIds];
        let added = true;
        while (added) {
            added = false;
            for (const s of shapes) {
                if (s.parentId && idsToRotate.includes(s.parentId) && !idsToRotate.includes(s.id)) {
                    idsToRotate.push(s.id);
                    added = true;
                }
            }
        }
        const initials: Record<string, { pos: THREE.Vector3, quat: THREE.Quaternion }> = {};
        shapes.filter(s => idsToRotate.includes(s.id)).forEach(s => {
            const obj = new THREE.Object3D();
            obj.position.set(...s.position);
            obj.rotation.set(...s.rotation);
            initials[s.id] = { pos: obj.position.clone(), quat: obj.quaternion.clone() };
        });
        return initials;
    }, [selectedIds, shapes]);

    const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
        if (tool !== ToolType.ROTATE) return;
        e.stopPropagation();

        if (phase === 'hover') {
            // --- Phase 1: set first axis point ---
            const pt = getSnapPoint(e);
            rotateRef.current.axisPoint1 = pt;
            setPhase('set-axis-end');
            setUiState(prev => ({ ...prev, axisPoint1: pt, axisPreviewEnd: pt, pivot: null, axis: null }));

        } else if (phase === 'set-axis-end') {
            // --- Phase 2: set second axis point → define axis ---
            const pt2 = getSnapPoint(e);
            const pt1 = rotateRef.current.axisPoint1!;
            const axisVec = new THREE.Vector3().subVectors(pt2, pt1);
            if (axisVec.lengthSq() < 0.0001) return; // too close, ignore

            let axis = axisVec.normalize();
            // Shift: snap axis to nearest cardinal direction
            if ((e as any).shiftKey) {
                const cardinals = [
                    new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1),
                    new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, -1),
                ];
                axis = cardinals.reduce((best, c) => axis.dot(c) > axis.dot(best) ? c : best, cardinals[0]).clone();
            }

            const pivot = pt1.clone();
            rotateRef.current.pivot = pivot;
            rotateRef.current.axis = axis;
            rotateRef.current.initialTransforms = buildInitials();
            setPhase('set-start');
            setUiState({ pivot, axis, axisPoint1: pt1, axisPreviewEnd: pt2 });

        } else if (phase === 'set-start') {
            // --- Phase 3: set start reference vector ---
            const pivot = rotateRef.current.pivot!;
            const axis = rotateRef.current.axis;
            const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, pivot);
            const current = new THREE.Vector3();
            if (e.ray.intersectPlane(plane, current)) {
                const v = new THREE.Vector3().subVectors(current, pivot);
                const projectedV = v.clone().sub(axis.clone().multiplyScalar(v.dot(axis)));
                if (projectedV.lengthSq() > 0.0001) {
                    rotateRef.current.startVector = projectedV.normalize();
                    setPhase('rotating');
                }
            }

        } else if (phase === 'rotating') {
            // --- Phase 4: commit ---
            const updates = Object.keys(rotateRef.current.initialTransforms).map(id => {
                const ref = shapeRefs.current[id];
                if (ref) {
                    return {
                        id,
                        changes: {
                            position: [ref.position.x, ref.position.y, ref.position.z] as [number, number, number],
                            rotation: [ref.rotation.x, ref.rotation.y, ref.rotation.z] as [number, number, number]
                        }
                    };
                }
                return null;
            }).filter(Boolean) as any;
            if (updates.length > 0) updateShapes(updates);
            setPhase('hover');
            rotateRef.current = { axisPoint1: null, pivot: null, axis: new THREE.Vector3(0, 1, 0), startVector: null, initialTransforms: {} };
            setUiState({ pivot: null, axis: null, axisPoint1: null, axisPreviewEnd: null });
        }
    }, [tool, phase, getSnapPoint, buildInitials, updateShapes, shapeRefs]);

    const handleRotateMove = useCallback((e: ThreeEvent<PointerEvent>) => {
        if (tool !== ToolType.ROTATE) return;

        if (phase === 'hover') {
            const pt = getSnapPoint(e);
            setUiState(prev => ({ ...prev, axisPreviewEnd: pt }));
        } else if (phase === 'set-axis-end') {
            const pt = getSnapPoint(e);
            setUiState(prev => ({ ...prev, axisPreviewEnd: pt }));
        } else if (phase === 'rotating' && rotateRef.current.pivot && rotateRef.current.startVector) {
            const pivot = rotateRef.current.pivot;
            const axis = rotateRef.current.axis;
            const startVector = rotateRef.current.startVector;
            const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, pivot);
            const current = new THREE.Vector3();
            if (e.ray.intersectPlane(plane, current)) {
                const v = new THREE.Vector3().subVectors(current, pivot);
                const projectedV = v.clone().sub(axis.clone().multiplyScalar(v.dot(axis)));
                if (projectedV.lengthSq() > 0.0001) {
                    const currVec = projectedV.normalize();
                    const cross = new THREE.Vector3().crossVectors(startVector, currVec);
                    const dot = startVector.dot(currVec);
                    let angle = Math.atan2(cross.length(), dot);
                    if (cross.dot(axis) < 0) angle = -angle;
                    if (e.shiftKey) { const SNAP = Math.PI / 12; angle = Math.round(angle / SNAP) * SNAP; }
                    const deg = Math.round((angle * 180) / Math.PI);
                    setMeasurement(`旋轉角度: ${deg}° (按住 Shift 可鎖定 15°)`);
                    Object.keys(rotateRef.current.initialTransforms).forEach(id => {
                        const ref = shapeRefs.current[id];
                        if (!ref) return;
                        const init = rotateRef.current.initialTransforms[id];
                        const vPos = new THREE.Vector3().subVectors(init.pos, pivot);
                        vPos.applyAxisAngle(axis, angle);
                        const newPos = new THREE.Vector3().addVectors(pivot, vPos);
                        const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
                        q.multiply(init.quat);
                        ref.position.copy(newPos);
                        ref.quaternion.copy(q);
                    });
                }
            }
        }
    }, [tool, phase, getSnapPoint, setMeasurement, shapeRefs]);

    return {
        rotatePhase: phase,
        handleRotateMove,
        handleClick,
        rotateData: rotateRef,
        rotateUI: uiState
    };
};

const useDrawingManager = () => {
    const { tool, addShape, shapes, wallThickness, setTool, replaceShapes, updateShape, setMeasurement, activeLayerId, addGuideLine, removeShape, removeGuideLine, decomposeFlat, unit, formatValue, selectShapes, selectedIds, guideLines } = useApp();
    const { camera, gl, raycaster } = useThree();
    // Guard: prevent replaceShapes from being called twice in the same tick
    // (once from attemptGeometryCut and once from updatePolygons via setTimeout).
    const polygonUpdatePending = useRef(false);
    const shapesRef = useRef(shapes);
    useEffect(() => { shapesRef.current = shapes; }, [shapes]);
    const guideLinesRef = useRef(guideLines);
    useEffect(() => { guideLinesRef.current = guideLines; }, [guideLines]);
    const [drawPoints, setDrawPointsState] = useState<IPoint[]>([]);
    const drawPointsRef = useRef<IPoint[]>([]);
    const setDrawPoints = useCallback((updater: IPoint[] | ((prev: IPoint[]) => IPoint[])) => {
        const next = typeof updater === 'function' ? updater(drawPointsRef.current) : updater;
        drawPointsRef.current = next;
        setDrawPointsState(next);
    }, []);
    const [cursorPos, setCursorPos] = useState<THREE.Vector3>(new THREE.Vector3());
    const cursorPosRef = useRef<THREE.Vector3>(new THREE.Vector3());
    const [snapInfo, setSnapInfo] = useState<SnapResult | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [drawingHeight, setDrawingHeight] = useState(0);
    const [typedInput, setTypedInput] = useState('');
    const [drawingNormal, setDrawingNormal] = useState<THREE.Vector3>(new THREE.Vector3(0, 1, 0));
    const [drawingParentId, setDrawingParentId] = useState<string | undefined>(undefined);
    const [guideCreation, setGuideCreation] = useState<{ active: boolean, start: THREE.Vector3, current: THREE.Vector3, edge: [THREE.Vector3, THREE.Vector3] | null }>({ active: false, start: new THREE.Vector3(), current: new THREE.Vector3(), edge: null });
    const [inferenceGuide, setInferenceGuide] = useState<InferenceGuide | null>(null);
    const currentChainIds = useRef<string[]>([]); 
    
    // Box Selection State
    const [selectionBox, setSelectionBox] = useState<{ start: THREE.Vector2 | null, current: THREE.Vector2 | null }>({ start: null, current: null });

    useEffect(() => { 
        setDrawPoints([]); setSnapInfo(null); setIsDragging(false); setDrawingHeight(0); setMeasurement(''); setTypedInput(''); setGuideCreation({ active: false, start: new THREE.Vector3(), current: new THREE.Vector3(), edge: null }); setDrawingNormal(new THREE.Vector3(0, 1, 0)); setInferenceGuide(null); currentChainIds.current = [];
        setSelectionBox({ start: null, current: null });
        setDrawingParentId(undefined);
    }, [tool, setMeasurement]);

    const attemptGeometryCut = useCallback((p1: THREE.Vector3, p2: THREE.Vector3, lineShape?: IShape): boolean => {
        let cutOccurred = false;
        const start = { x: p1.x, y: 0, z: p1.z };
        const end = { x: p2.x, y: 0, z: p2.z };

        const flatShapes = shapes.filter(s => (s.type === 'flat' || s.type === 'solid') && s.name !== 'Edge' && !s.groupId);
        const idsToRemove = new Set<string>();
        const shapesToAddList: IShape[] = [];
        // Collect all entry/exit intersection points for computing external segments
        const cutIntersections: Array<{ entry: IPoint; exit: IPoint }> = [];

        const createFragment = (points: IPoint[], suffix: string, originalShape: IShape) => {
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            points.forEach(p => { 
                if (!p) return;
                if(p.x < minX) minX = p.x; 
                if(p.x > maxX) maxX = p.x; 
                if(p.z < minZ) minZ = p.z; 
                if(p.z > maxZ) maxZ = p.z; 
            });
            const cx = (minX + maxX) / 2;
            const cz = (minZ + maxZ) / 2;
            const localPoints = points.filter(p => !!p).map(p => ({ x: p.x - cx, y: 0, z: p.z - cz }));
            
            return {
                ...originalShape,
                id: `split-${Date.now()}-${suffix}-${Math.random()}`,
                points: localPoints,
                position: [cx, originalShape.position[1], cz] as [number, number, number],
                rotation: [0, 0, 0] as [number, number, number], 
                scale: [1, 1, 1] as [number, number, number],
                name: originalShape.name
            };
        };

        // Bounding box for the cutting segment
        const segMinX = Math.min(p1.x, p2.x) - 0.1;
        const segMaxX = Math.max(p1.x, p2.x) + 0.1;
        const segMinZ = Math.min(p1.z, p2.z) - 0.1;
        const segMaxZ = Math.max(p1.z, p2.z) + 0.1;

        for (const shape of flatShapes) {
             if (idsToRemove.has(shape.id)) continue;
             if (Math.abs(shape.position[1] - p1.y) > 0.1) continue;

             // Simple bounding box overlap check
             const bounds = getShapeBounds(shape);
             if (bounds.maxX < segMinX || bounds.minX > segMaxX || bounds.maxZ < segMinZ || bounds.minZ > segMaxZ) {
                 continue;
             }

             const worldPoints = shape.points.map(p => {
                 const wp = transformPoint(p, shape);
                 return { x: wp.x, y: 0, z: wp.z };
             });

             const splitResult = cutPolygonBySegment(worldPoints, start, end);
             if (splitResult) {
                 const { polyA, polyB, entry, exit } = splitResult;
                 shapesToAddList.push(createFragment(polyA, 'A', shape));
                 shapesToAddList.push(createFragment(polyB, 'B', shape));
                 idsToRemove.add(shape.id);
                 cutIntersections.push({ entry, exit });
                 cutOccurred = true;
             }
        }

        if (cutOccurred && lineShape) {
            // Remove the original drawn line
            idsToRemove.add(lineShape.id);

            // Build external segments: portions of the line outside all cut shapes
            // Strategy: start from p1, skip over all [entry, exit] intervals, emit segment for each gap
            const MIN_LEN = 0.001;
            // Sort intersections by distance from p1
            const lineDir = new THREE.Vector3(p2.x - p1.x, 0, p2.z - p1.z);
            const lineLen = lineDir.length();
            if (lineLen > MIN_LEN) {
                // Project each entry/exit onto the line parameter t ∈ [0, lineLen]
                interface Interval { t0: number; t1: number }
                const intervals: Interval[] = cutIntersections.map(({ entry, exit }) => {
                    const t0 = ((entry.x - p1.x) * lineDir.x + (entry.z - p1.z) * lineDir.z) / lineLen;
                    const t1 = ((exit.x - p1.x) * lineDir.x + (exit.z - p1.z) * lineDir.z) / lineLen;
                    return t0 <= t1 ? { t0, t1 } : { t0: t1, t1: t0 };
                });
                intervals.sort((a, b) => a.t0 - b.t0);

                // Merge overlapping intervals
                const merged: Interval[] = [];
                for (const iv of intervals) {
                    if (merged.length === 0 || iv.t0 > merged[merged.length - 1].t1 + MIN_LEN) {
                        merged.push({ ...iv });
                    } else {
                        merged[merged.length - 1].t1 = Math.max(merged[merged.length - 1].t1, iv.t1);
                    }
                }

                // Helper: point at parameter t along the line
                const ptAt = (t: number) => ({
                    x: p1.x + (lineDir.x / lineLen) * t,
                    y: p1.y,
                    z: p1.z + (lineDir.z / lineLen) * t,
                });

                // Emit external segments
                const addSegment = (tA: number, tB: number) => {
                    if (tB - tA < MIN_LEN) return;
                    const segStart = ptAt(tA);
                    const segEnd   = ptAt(tB);
                    shapesToAddList.push({
                        ...lineShape,
                        id: `line-ext-${Date.now()}-${Math.random()}`,
                        position: [segStart.x, segStart.y, segStart.z],
                        points: [
                            { x: 0, y: 0, z: 0 },
                            { x: segEnd.x - segStart.x, y: segEnd.y - segStart.y, z: segEnd.z - segStart.z },
                        ],
                        rotation: [0, 0, 0],
                        scale: [1, 1, 1],
                    });
                };

                let prevT = 0;
                for (const iv of merged) {
                    addSegment(prevT, iv.t0);
                    prevT = iv.t1;
                }
                addSegment(prevT, lineLen);
            }
        }

        if (cutOccurred) {
            replaceShapes(Array.from(idsToRemove), shapesToAddList);
        }
        return cutOccurred;
    }, [shapes, replaceShapes]);

    const addPoint = useCallback((point: THREE.Vector3) => {
        if (drawPoints.length > 0) {
            const start = drawPoints[0];
            const dist = point.distanceTo(new THREE.Vector3(start.x, start.y, start.z));
            
            if (dist < SNAP_THRESHOLD && tool !== ToolType.DRAW_LINE) {
                const finalPoints = [...drawPoints];
                const idsToRemove = [...currentChainIds.current];
                currentChainIds.current = [];
                const createShapeObj = (base: Partial<IShape>): IShape => ({ ...base as IShape, layerId: activeLayerId });
                let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
                finalPoints.forEach(p => { if(p.x < minX) minX = p.x; if(p.x > maxX) maxX = p.x; if(p.z < minZ) minZ = p.z; if(p.z > maxZ) maxZ = p.z; });
                const cx = (minX + maxX) / 2; const cz = (minZ + maxZ) / 2;
                const localPoints = finalPoints.map(p => ({ x: p.x - cx, y: 0, z: p.z - cz }));
                
                const newFace = createShapeObj({
                    id: `face-${Date.now()}-${Math.random()}`,
                    type: 'flat',
                    name: '平面',
                    points: localPoints,
                    height: 0,
                    color: FLAT_COLOR,
                    position: [cx, finalPoints[0].y, cz],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1]
                });
                
                replaceShapes(idsToRemove, [newFace]);
                setDrawPoints([]);
                setMeasurement('已建立平面');
                return;
            }
        }

        const newPoint = { x: point.x, y: point.y, z: point.z };
        const newPointsList = [...drawPoints, newPoint];
        setDrawPoints(newPointsList);

    }, [drawPoints, tool, activeLayerId, addShape, replaceShapes, attemptGeometryCut, shapes]);

    const finishShape = useCallback((finalPoints: IPoint[]) => {
        const createShapeObj = (base: Partial<IShape>): IShape => ({ ...base as IShape, layerId: activeLayerId });
        const { right, top, normal } = getLocalBasis(drawingNormal);
        const rotationMatrix = new THREE.Matrix4().makeBasis(right, normal, top);
        const quaternion = new THREE.Quaternion().setFromRotationMatrix(rotationMatrix);
        const euler = new THREE.Euler().setFromQuaternion(quaternion);
        
        if (finalPoints.length === 0 || !finalPoints[0]) {
             setDrawPoints([]);
             return;
        }

        const startPoint = new THREE.Vector3(finalPoints[0].x, finalPoints[0].y, finalPoints[0].z);
        
        const parentId = drawingParentId;
        
        const newShapeBase: Partial<IShape> = { height: DEFAULT_HEIGHT, color: FLAT_COLOR, rotation: [euler.x, euler.y, euler.z], scale: [1, 1, 1], position: [0,0,0], parentId };
        let newShapePoints: IPoint[] = [];
        let isLine = false;
        let lineP1: THREE.Vector3 | null = null;
        let lineP2: THREE.Vector3 | null = null;

        if (tool === ToolType.DRAW_LINE && finalPoints.length >= 2) {
             const endPt = finalPoints[finalPoints.length - 1];
             if (endPt) {
                 const endPoint = new THREE.Vector3(endPt.x, endPt.y, endPt.z);
                 if (startPoint.distanceTo(endPoint) > 0.001) {
                     newShapePoints = [{ x: 0, y: 0, z: 0 }, { x: endPoint.x - startPoint.x, y: endPoint.y - startPoint.y, z: endPoint.z - startPoint.z }];
                     newShapeBase.id = `line-${Date.now()}-${Math.random()}`;
                     newShapeBase.type = 'line';
                     newShapeBase.name = '直線';
                     newShapeBase.position = [startPoint.x, startPoint.y, startPoint.z];
                     newShapeBase.rotation = [0, 0, 0];
                     newShapeBase.lineWidth = 0;
                     newShapeBase.color = '#000000';
                     isLine = true;
                     lineP1 = startPoint;
                     lineP2 = endPoint;
                 }
             }
        } else if (tool === ToolType.DRAW_RECT && finalPoints.length >= 2) {
             const endPt = finalPoints[finalPoints.length - 1];
             if (endPt) {
                 const endPoint = new THREE.Vector3(endPt.x, endPt.y, endPt.z);
                 const diff = new THREE.Vector3().subVectors(endPoint, startPoint);
                 const width = diff.dot(right); const depth = diff.dot(top);
                 if (Math.abs(width) >= 0.01 && Math.abs(depth) >= 0.01) {
                     const worldCenter = startPoint.clone().add(right.clone().multiplyScalar(width / 2)).add(top.clone().multiplyScalar(depth / 2));
                     const halfW = Math.abs(width) / 2; const halfD = Math.abs(depth) / 2;
                     newShapePoints = [ { x: -halfW, y: 0, z: -halfD }, { x: halfW, y: 0, z: -halfD }, { x: halfW, y: 0, z: halfD }, { x: -halfW, y: 0, z: halfD } ];
                     newShapeBase.id = `rect-${Date.now()}-${Math.random()}`; newShapeBase.type = 'flat'; newShapeBase.name = '矩形'; newShapeBase.position = [worldCenter.x, worldCenter.y, worldCenter.z];
                 }
             }
        } else if (tool === ToolType.DRAW_CIRCLE && finalPoints.length >= 2) {
            if (finalPoints[1]) {
                const endPoint = new THREE.Vector3(finalPoints[1].x, finalPoints[1].y, finalPoints[1].z);
                const radius = startPoint.distanceTo(endPoint);
                if (radius > 0.01) { newShapePoints = createCirclePoints(radius); newShapeBase.id = `circle-${Date.now()}-${Math.random()}`; newShapeBase.type = 'flat'; newShapeBase.name = '圓形'; newShapeBase.position = [startPoint.x, startPoint.y, startPoint.z]; }
            }
        } else if (tool === ToolType.DIMENSION && finalPoints.length >= 3) {
            const validPoints = finalPoints.filter(p => !!p);
            if (validPoints.length >= 3) {
                newShapePoints = [validPoints[0], validPoints[1], validPoints[2]]; 
                newShapeBase.id = `dim-${Date.now()}-${Math.random()}`; 
                newShapeBase.type = 'dimension'; 
                newShapeBase.name = '尺寸標註'; 
                newShapeBase.color = '#333';
                newShapeBase.position = [0, 0, 0]; 
            }
        }

        if (newShapePoints.length > 0) {
             const finalNewShape: IShape = createShapeObj({ ...newShapeBase as IShape, points: newShapePoints });
             addShape(finalNewShape);
             
             let didCut = false;
             if (isLine && lineP1 && lineP2) {
                 currentChainIds.current.push(finalNewShape.id);
                 didCut = attemptGeometryCut(lineP1, lineP2, finalNewShape);
             }

             // Skip updatePolygons when attemptGeometryCut already split a shape —
             // it used the current shapes state, but updatePolygons runs in a
             // setTimeout with a stale closure, which would re-detect the same
             // polygons and create duplicate fragments.
             if (!didCut && finalNewShape.type === 'line' && !polygonUpdatePending.current) {
                 polygonUpdatePending.current = true;
                 setTimeout(() => {
                     const currentShapes = shapesRef.current;
                     const shapesForDetection = currentShapes.some(s => s.id === finalNewShape.id)
                         ? currentShapes
                         : [...currentShapes, finalNewShape];
                     updatePolygons(shapesForDetection, replaceShapes, activeLayerId, [finalNewShape.id]);
                     polygonUpdatePending.current = false;
                 }, 0);
             }
        }
        
        if (tool !== ToolType.DRAW_LINE) {
            setDrawPoints([]); 
            setDrawingParentId(undefined);
            setMeasurement(''); 
            setTypedInput('');
        }

    }, [tool, addShape, replaceShapes, activeLayerId, drawingNormal, drawingParentId, setTool, setMeasurement, snapInfo, shapes, attemptGeometryCut]);

    const handleInputSubmit = useCallback(() => {
        if (!typedInput) return;
        
        const scaleFactor = unit === 'cm' ? 0.01 : 1;

        if (tool === ToolType.GUIDE_LINE && guideCreation.active && guideCreation.edge) {
            let val = parseFloat(typedInput);
            if (isNaN(val)) return;
            val = val * scaleFactor;

            const p1 = guideCreation.edge[0];
            const p2 = guideCreation.edge[1];
            const direction = new THREE.Vector3().subVectors(p2, p1).normalize();
            const lineStart = guideCreation.current.clone();
            if (Math.abs(p1.y - p2.y) < 0.01) {
                lineStart.y = p1.y;
            }

            const v = new THREE.Vector3().subVectors(lineStart, p1);
            const projection = v.dot(direction);
            const projectedPointOnEdgeLine = p1.clone().add(direction.clone().multiplyScalar(projection));
            const rejection = new THREE.Vector3().subVectors(lineStart, projectedPointOnEdgeLine);
            
            let rejectionDir = rejection.clone().normalize();
            if (rejectionDir.lengthSq() < 0.0001) {
                rejectionDir = new THREE.Vector3(-direction.z, 0, direction.x).normalize();
            }

            const newStart = projectedPointOnEdgeLine.clone().add(rejectionDir.multiplyScalar(val));
            const newEnd = newStart.clone().add(direction);
            
            addGuideLine({ id: `guide-${Date.now()}-${Math.random()}`, points: [ [newStart.x, newStart.y, newStart.z], [newEnd.x, newEnd.y, newEnd.z] ] });
            
            setGuideCreation({ active: false, start: new THREE.Vector3(), current: new THREE.Vector3(), edge: null }); 
            setMeasurement(''); 
            setTypedInput('');
            return;
        }

        if (drawPoints.length === 0) return;
        const start = drawPoints[drawPoints.length - 1]; 
        if (!start) return;
        
        const startVec = new THREE.Vector3(start.x, start.y, start.z); const cursorVec = cursorPos.clone();
        let targetVec = new THREE.Vector3(); const direction = cursorVec.clone().sub(startVec).normalize();
        
        if (tool === ToolType.DRAW_RECT) {
            const parts = typedInput.split(/[, ]+/).filter(p => p.trim() !== '').map(parseFloat);
            if (parts.length > 0 && !parts.some(isNaN)) {
                const { right, top: topVec } = getLocalBasis(drawingNormal);
                const diff = cursorVec.clone().sub(startVec);
                const wSign = Math.sign(diff.dot(right)) || 1;
                const hSign = Math.sign(diff.dot(topVec)) || 1;
                const wVal = parts[0] * scaleFactor * wSign;
                const hVal = (parts.length > 1 ? parts[1] : parts[0]) * scaleFactor * hSign;
                targetVec = startVec.clone()
                    .add(right.clone().multiplyScalar(wVal))
                    .add(topVec.clone().multiplyScalar(hVal));
            }
        } else if (tool === ToolType.DRAW_CIRCLE) {
            // Circle: user types a radius; generate circle from center (startVec)
            let radius = parseFloat(typedInput);
            if (isNaN(radius) || radius <= 0) return;
            radius *= scaleFactor;
            if (cursorVec.distanceTo(startVec) < 0.001) { direction.set(1, 0, 0); }
            const edgePt = startVec.clone().add(direction.multiplyScalar(radius));
            finishShape([
                { x: startVec.x, y: startVec.y, z: startVec.z },
                { x: edgePt.x, y: edgePt.y, z: edgePt.z },
            ]);
            setTypedInput('');
            return;
        } else {
            let val = parseFloat(typedInput);
            if (isNaN(val)) return;
            val = val * scaleFactor;

            if (cursorVec.distanceTo(startVec) < 0.001) { direction.set(1, 0, 0); }
            targetVec = startVec.clone().add(direction.multiplyScalar(val));
        }

        const finalPoints = [...drawPoints, { x: targetVec.x, y: targetVec.y, z: targetVec.z }];
        finishShape(finalPoints);
        
        if (tool === ToolType.DRAW_LINE) {
            setDrawPoints([{ x: targetVec.x, y: targetVec.y, z: targetVec.z }, { x: targetVec.x, y: targetVec.y, z: targetVec.z }]);
        }
    }, [typedInput, drawPoints, cursorPos, tool, finishShape, addPoint, unit, guideCreation, addGuideLine, setMeasurement]);

    const setSelectionBoxWithEvent = useCallback((updater: React.SetStateAction<{ start: THREE.Vector2 | null, current: THREE.Vector2 | null }>) => {
        setSelectionBox(prev => {
            const next = typeof updater === 'function' ? updater(prev) : updater;
            window.dispatchEvent(new CustomEvent('selectionBoxUpdate', { detail: next }));
            return next;
        });
    }, []);

    useEffect(() => {
        const handleCanvasPointerMissed = (e: CustomEvent<MouseEvent>) => {
            if (tool === ToolType.SELECT && e.detail.button === 0) {
                const startVec = new THREE.Vector2(e.detail.clientX, e.detail.clientY);
                setSelectionBoxWithEvent({ start: startVec, current: startVec });
                setIsDragging(true);
            }
        };
        window.addEventListener('canvasPointerMissed', handleCanvasPointerMissed as EventListener);
        return () => window.removeEventListener('canvasPointerMissed', handleCanvasPointerMissed as EventListener);
    }, [tool, setSelectionBoxWithEvent]);

    const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
        if (tool === ToolType.PUSH_PULL || tool === ToolType.ROTATE || tool === ToolType.HAND) return;
        if (e.button !== 0) return;

        // Unified ERASER hit detection: shape meshes no longer stop propagation in
        // ERASER mode, so this handler is the single place that decides what to delete.
        // Priority: (1) nearest line shape by XZ distance, (2) nearest guide line,
        // (3) any shape mesh found in e.intersections.
        if (tool === ToolType.ERASER) {
            const clickPt = e.point;
            const camDist = Math.max(1, camera.position.length());
            const lineThreshold = Math.max(0.2, Math.min(camDist * 0.03, 2.0));
            const guideThreshold = Math.max(0.3, Math.min(camDist * 0.04, 2.5));
            const clickXZ = new THREE.Vector3(clickPt.x, 0, clickPt.z);

            // Priority 1: nearest line shape by segment distance
            let bestLineDist = lineThreshold;
            let bestLineId: string | null = null;
            for (const s of shapesRef.current) {
                if (s.type !== 'line' || !s.points || s.points.length < 2) continue;
                const pos = s.position || [0, 0, 0];
                for (let i = 0; i < s.points.length - 1; i++) {
                    const wp1 = new THREE.Vector3(pos[0] + s.points[i].x, 0, pos[2] + s.points[i].z);
                    const wp2 = new THREE.Vector3(pos[0] + s.points[i + 1].x, 0, pos[2] + s.points[i + 1].z);
                    const seg = new THREE.Vector3().subVectors(wp2, wp1);
                    const segLen = seg.length();
                    if (segLen < 1e-6) continue;
                    seg.normalize();
                    const t = Math.max(0, Math.min(segLen, new THREE.Vector3().subVectors(clickXZ, wp1).dot(seg)));
                    const dist = clickXZ.distanceTo(wp1.clone().add(seg.multiplyScalar(t)));
                    if (dist < bestLineDist) { bestLineDist = dist; bestLineId = s.id; }
                }
            }
            if (bestLineId) {
                e.stopPropagation();
                removeShape(bestLineId);
                return;
            }

            // Priority 2: nearest guide line by distance
            let bestGuideDist = guideThreshold;
            let bestGuideId: string | null = null;
            for (const guideLine of guideLinesRef.current) {
                const p1 = new THREE.Vector3(guideLine.points[0][0], 0, guideLine.points[0][2]);
                const p2 = new THREE.Vector3(guideLine.points[1][0], 0, guideLine.points[1][2]);
                const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
                const proj = new THREE.Vector3().subVectors(clickXZ, p1).dot(dir);
                const dist = clickXZ.distanceTo(p1.clone().add(dir.clone().multiplyScalar(proj)));
                if (dist < bestGuideDist) { bestGuideDist = dist; bestGuideId = guideLine.id; }
            }
            if (bestGuideId) {
                e.stopPropagation();
                removeGuideLine(bestGuideId);
                return;
            }

            // Priority 3: shape mesh hit (flat/solid/door/image shapes bubble up to here)
            const hits = e.intersections as unknown as THREE.Intersection[];
            for (const hit of hits) {
                let obj: THREE.Object3D | null = hit.object;
                let shapeId: string | undefined;
                while (obj) {
                    if (obj.userData?.isShape && obj.userData?.id) { shapeId = obj.userData.id; break; }
                    obj = obj.parent;
                }
                if (!shapeId) continue;
                const target = shapesRef.current.find(s => s.id === shapeId);
                if (!target) continue;
                e.stopPropagation();
                if (target.type === 'flat') {
                    blockErasedPolygon(target);
                    decomposeFlat(target.id);
                } else {
                    removeShape(target.id);
                }
                return;
            }

            // Nothing hit — consume to prevent accidental drawing
            e.stopPropagation();
            return;
        }

        e.stopPropagation();
        
        // Handle Select Box Logic
        if (tool === ToolType.SELECT) {
            // Check if we clicked a shape
            const isShape = e.object.userData?.isShape || e.object.parent?.userData?.isShape;
            if (isShape) {
                // If we clicked a shape, we don't want to start box select
                return;
            }
            
            const startVec = new THREE.Vector2(e.nativeEvent.clientX, e.nativeEvent.clientY);
            setSelectionBoxWithEvent({ start: startVec, current: startVec });
            setIsDragging(true);
            return;
        }

        const pt = snapInfo ? snapInfo.position.clone() : (e as any).point.clone();
        setCursorPos(pt.clone());
        if (drawPoints.length === 0) { 
            if (snapInfo && (snapInfo.type === 'face' || snapInfo.type === 'vertex' || snapInfo.type === 'edge') && snapInfo.normal) {
                setDrawingNormal(snapInfo.normal.clone()); 
            } else {
                setDrawingNormal(new THREE.Vector3(0, 1, 0)); 
            }
            
            let parentId = undefined;
            if (snapInfo && snapInfo.snapObjectId) {
                const snappedShape = shapes.find(s => s.id === snapInfo.snapObjectId);
                if (snapInfo.type === 'face' || (snappedShape && (snappedShape.height ?? 0) > 0.001)) {
                    parentId = snapInfo.snapObjectId;
                    if (snappedShape && snappedShape.parentId && (snappedShape.height ?? 0) < 0) {
                        parentId = snappedShape.parentId;
                    }
                }
            }
            setDrawingParentId(parentId);
        }
        
        if (tool === ToolType.GUIDE_LINE && snapInfo && snapInfo.type === 'edge' && snapInfo.snapEdge) { 
             setIsDragging(true); 
             setGuideCreation({ active: true, start: pt.clone(), current: pt.clone(), edge: snapInfo.snapEdge }); 
             setMeasurement('移動滑鼠以建立平行輔助線');
             return; 
        }
        
        if (tool === ToolType.GUIDE_LINE) {
            setIsDragging(true);
            setGuideCreation({ active: true, start: pt.clone(), current: pt.clone(), edge: null });
            setMeasurement('移動滑鼠以建立參考線');
            return;
        }

        setIsDragging(true);
        
        if (drawPointsRef.current.length === 0) { 
            setDrawPoints([{ x: pt.x, y: pt.y, z: pt.z }]); 
            if (tool === ToolType.DRAW_RECT || tool === ToolType.DRAW_CIRCLE || tool === ToolType.DRAW_LINE) {
                setDrawPoints(prev => [...prev, { x: pt.x, y: pt.y, z: pt.z }]); 
            } 
        } else if (tool === ToolType.DIMENSION) {
            setDrawPoints(prev => [...prev, { x: pt.x, y: pt.y, z: pt.z }]);
        } else if (tool === ToolType.DRAW_LINE) {
            // For continuous drawing, we don't need to add a point on pointer down if we already have points,
            // because the pointer up event handles finishing the segment and starting the next one.
            // However, we might want to ensure the current cursor position is tracked.
            // The actual segment completion is handled in handlePointerUp.
        }
    }, [tool, snapInfo, addPoint, setMeasurement, setDrawPoints, removeGuideLine, removeShape]);

    const handlePointerUp = useCallback((e: ThreeEvent<PointerEvent> | { nativeEvent: Pick<PointerEvent, 'shiftKey'> }) => {
        if (tool === ToolType.PUSH_PULL || tool === ToolType.ROTATE || tool === ToolType.HAND) return;
        setIsDragging(false);
        
        // Handle Box Select End
        if (tool === ToolType.SELECT && selectionBox.start && selectionBox.current) {
            const start = selectionBox.start;
            const end = selectionBox.current;
            
            const rect = gl.domElement.getBoundingClientRect();
            const minX = Math.min(start.x, end.x) - rect.left;
            const maxX = Math.max(start.x, end.x) - rect.left;
            const minY = Math.min(start.y, end.y) - rect.top;
            const maxY = Math.max(start.y, end.y) - rect.top;
            
            if (Math.abs(maxX - minX) > 5 || Math.abs(maxY - minY) > 5) {
                const isLeftToRight = end.x >= start.x;
                const selected: string[] = [];
                // Check all shapes
                shapes.forEach(shape => {
                    let isInside = false;
                    
                    const checkPoint = (vec: THREE.Vector3) => {
                        const ndc = vec.clone().project(camera);
                        if (ndc.z > 1 || ndc.z < -1) return false;
                        const screenX = (ndc.x + 1) * rect.width / 2;
                        const screenY = (-ndc.y + 1) * rect.height / 2;
                        return screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY;
                    };

                    if (isLeftToRight) {
                        // Window Selection (Left-to-Right): ALL vertices must be inside
                        if (shape.points && shape.points.length > 0) {
                            let allInside = true;
                            for (const p of shape.points) {
                                const worldP = transformPoint(p, shape);
                                if (!checkPoint(worldP)) {
                                    allInside = false;
                                    break;
                                }
                                if (shape.height) {
                                    const topP = worldP.clone();
                                    topP.y += shape.height * (shape.scale?.[1] || 1);
                                    if (!checkPoint(topP)) {
                                        allInside = false;
                                        break;
                                    }
                                }
                            }
                            isInside = allInside;
                        } else {
                            const center = new THREE.Vector3(...shape.position);
                            isInside = checkPoint(center);
                            if (isInside && shape.height) {
                                const topCenter = center.clone();
                                topCenter.y += shape.height * (shape.scale?.[1] || 1);
                                isInside = checkPoint(topCenter);
                            }
                        }
                    } else {
                        // Crossing Selection (Right-to-Left): ANY vertex inside (or center)
                        const center = new THREE.Vector3(...shape.position);
                        if (checkPoint(center)) {
                            isInside = true;
                        } else if (shape.height && checkPoint(center.clone().setY(center.y + shape.height * (shape.scale?.[1] || 1)))) {
                            isInside = true;
                        } else if (shape.points && shape.points.length > 0) {
                            for (const p of shape.points) {
                                const worldP = transformPoint(p, shape);
                                if (checkPoint(worldP)) {
                                    isInside = true;
                                    break;
                                }
                                if (shape.height) {
                                    const topP = worldP.clone();
                                    topP.y += shape.height * (shape.scale?.[1] || 1);
                                    if (checkPoint(topP)) {
                                        isInside = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    
                    if (isInside) {
                        selected.push(shape.id);
                    }
                });
                
                if (selected.length > 0) {
                    if (e.nativeEvent.shiftKey) {
                        const newSelection = Array.from(new Set([...selectedIds, ...selected]));
                        selectShapes(newSelection);
                    } else {
                        selectShapes(selected);
                    }
                } else if (!e.nativeEvent.shiftKey) {
                    selectShapes([]);
                }
            } else {
                // It was a click on the background
                if (!e.nativeEvent.shiftKey) {
                    selectShapes([]);
                }
            }
            setSelectionBoxWithEvent({ start: null, current: null });
            return;
        }
        
        if (tool === ToolType.SELECT) return;

        if (tool === ToolType.GUIDE_LINE && guideCreation.active) {
            if (guideCreation.edge) {
                const p1 = guideCreation.edge![0]; 
                const p2 = guideCreation.edge![1]; 
                const direction = new THREE.Vector3().subVectors(p2, p1).normalize();
                
                const lineStart = guideCreation.current.clone();
                if (Math.abs(p1.y - p2.y) < 0.01) {
                    lineStart.y = p1.y;
                }

                const v = new THREE.Vector3().subVectors(lineStart, p1);
                const projection = v.dot(direction);
                const projectedPointOnEdgeLine = p1.clone().add(direction.clone().multiplyScalar(projection));
                const rejection = new THREE.Vector3().subVectors(lineStart, projectedPointOnEdgeLine);
                
                lineStart.copy(p1.clone().add(rejection));

                let guideDirection = direction.clone();

                const lineEnd = lineStart.clone().add(guideDirection);
                addGuideLine({ id: `guide-${Date.now()}-${Math.random()}`, points: [ [lineStart.x, lineStart.y, lineStart.z], [lineEnd.x, lineEnd.y, lineEnd.z] ] });
            } else if (tool === ToolType.GUIDE_LINE && !guideCreation.edge) {
                const dx = Math.abs(guideCreation.current.x - guideCreation.start.x);
                const dz = Math.abs(guideCreation.current.z - guideCreation.start.z);
                let start = guideCreation.start.clone();
                let end = guideCreation.start.clone();
                if (dx > dz) { end.x += 1; } else { end.z += 1; }
                addGuideLine({ id: `guide-axis-${Date.now()}-${Math.random()}`, points: [ [start.x, start.y, start.z], [end.x, end.y, end.z] ] });
            }
            setGuideCreation({ active: false, start: new THREE.Vector3(), current: new THREE.Vector3(), edge: null }); 
            setMeasurement(''); 
            return;
        }

        if (tool === ToolType.DOOR) {
            const doorShape: IShape = {
                id: `door-${Date.now()}-${Math.random()}`,
                layerId: activeLayerId,
                type: 'door',
                name: '門',
                points: [{ x: 0, y: 0, z: 0 }],
                position: [cursorPos.x, 0, cursorPos.z],
                rotation: [0, 0, 0],
                scale: [0.9, 1, 0.9],
                height: 0,
                color: '#1e293b',
                doorDirection: 'left',
                doorFlipped: false,
            };
            addShape(doorShape);
            setTool(ToolType.SELECT); // 放置後自動切回選取工具
            return;
        }

        if (tool === ToolType.DRAW_TEXT) {
             const newShape: IShape = {
                id: `text-${Date.now()}-${Math.random()}`,
                layerId: activeLayerId,
                type: 'text',
                name: '文字說明',
                points: [{ x: 0, y: 0, z: 0 }],
                position: [cursorPos.x, cursorPos.y, cursorPos.z],
                rotation: [-Math.PI/2, 0, 0], 
                scale: [1, 1, 1],
                height: 0,
                color: '#000000',
                content: '文字',
                fontSize: 0.5
            };
            addShape(newShape);
            return;
        }

        if (tool === ToolType.DIMENSION) { 
            if (drawPointsRef.current.length >= 3) finishShape([...drawPointsRef.current]); 
            return; 
        }
        
        if ((tool === ToolType.DRAW_RECT || tool === ToolType.DRAW_CIRCLE) && drawPointsRef.current.length >= 2) {
            const pos = cursorPosRef.current;
            const points = [...drawPointsRef.current];
            points[points.length-1] = { x: pos.x, y: pos.y, z: pos.z };
            finishShape(points);
        } else if (tool === ToolType.DRAW_LINE && drawPointsRef.current.length >= 2) {
            const pos = cursorPosRef.current;
            const points = [...drawPointsRef.current];
            points[points.length-1] = { x: pos.x, y: pos.y, z: pos.z };

            // Only finish the shape if the start and end points are different
            const startPt = new THREE.Vector3(points[0].x, points[0].y, points[0].z);
            const endPt = new THREE.Vector3(points[1].x, points[1].y, points[1].z);
            if (startPt.distanceTo(endPt) > 0.001) {
                finishShape(points);
                // Continue drawing from the last point
                setDrawPoints([{ x: pos.x, y: pos.y, z: pos.z }, { x: pos.x, y: pos.y, z: pos.z }]);
            }
        }
    }, [tool, finishShape, guideCreation, addGuideLine, setMeasurement, activeLayerId, addShape, setTool, selectionBox, shapes, camera, gl, selectShapes, setDrawPoints]);

    useEffect(() => {
        const handleWindowMove = (e: PointerEvent) => {
            if (tool === ToolType.SELECT && selectionBox.start) {
                setSelectionBoxWithEvent(prev => ({ ...prev, current: new THREE.Vector2(e.clientX, e.clientY) }));
            }
        };
        const handleWindowUp = (e: PointerEvent) => {
            if (tool === ToolType.SELECT && selectionBox.start) {
                // We need to call the same logic as handlePointerUp, but we don't have the ThreeEvent
                // We can just dispatch a custom event or call handlePointerUp with a mock event
                // Actually, handlePointerUp expects a ThreeEvent. 
                // Let's just create a custom event that handlePointerUp can listen to, or extract the logic.
                // For now, we can just dispatch a custom event and let handlePointerUp listen to it if we want.
                // Wait, handlePointerUp is a callback. We can just call it with a mock event.
                handlePointerUp({ nativeEvent: e });
            }
        };
        if (selectionBox.start) {
            window.addEventListener('pointermove', handleWindowMove);
            window.addEventListener('pointerup', handleWindowUp);
        }
        return () => {
            window.removeEventListener('pointermove', handleWindowMove);
            window.removeEventListener('pointerup', handleWindowUp);
        };
    }, [selectionBox.start, tool, setSelectionBoxWithEvent, handlePointerUp]);

    useEffect(() => { 
        if (guideCreation.active) {
            setGuideCreation(prev => ({ ...prev, current: cursorPos.clone() })); 
            
            if (tool === ToolType.GUIDE_LINE && guideCreation.edge) {
                 const p1 = guideCreation.edge[0].clone();
                 const p2 = guideCreation.edge[1].clone();
                 
                 if (Math.abs(p1.y - p2.y) < 0.01) {
                     p1.y = cursorPos.y;
                     p2.y = cursorPos.y;
                 }

                 const edgeVec = new THREE.Vector3().subVectors(p2, p1);
                 const v = new THREE.Vector3().subVectors(cursorPos, p1);
                 const d = edgeVec.clone().normalize();
                 const projection = v.dot(d);
                 const projectedPointOnEdgeLine = p1.clone().add(d.clone().multiplyScalar(projection));
                 const rejection = new THREE.Vector3().subVectors(cursorPos, projectedPointOnEdgeLine);
                 
                 setMeasurement(`距離: ${formatValue(rejection.length())}`);
            }
        }
    }, [cursorPos, guideCreation.active, tool, guideCreation.edge, formatValue, setMeasurement]);
    
    const handlePointerMove = useCallback((e: ThreeEvent<PointerEvent>) => {
        if (tool === ToolType.SELECT && selectionBox.start) {
            setSelectionBoxWithEvent(prev => ({ ...prev, current: new THREE.Vector2(e.nativeEvent.clientX, e.nativeEvent.clientY) }));
            return;
        }

        const point = e.intersections[0]?.point || e.point;
        
        let newInferenceGuide: InferenceGuide | null = null;
        if (tool === ToolType.DRAW_LINE && drawPoints.length > 0) {
            const lastPoint = drawPoints[drawPoints.length - 1];
            const lastVec = new THREE.Vector3(lastPoint.x, lastPoint.y, lastPoint.z);
            
            const dx = Math.abs(point.x - lastVec.x);
            const dz = Math.abs(point.z - lastVec.z);
            
            // Show vertical guide (along Z axis) if cursor is close to X alignment
            if (dx < 0.2 && dz > 0.2) {
                newInferenceGuide = {
                    type: 'z',
                    start: new THREE.Vector3(lastVec.x, lastVec.y, -1000),
                    end: new THREE.Vector3(lastVec.x, lastVec.y, 1000)
                };
            } 
            // Show horizontal guide (along X axis) if cursor is close to Z alignment
            else if (dz < 0.2 && dx > 0.2) {
                newInferenceGuide = {
                    type: 'x',
                    start: new THREE.Vector3(-1000, lastVec.y, lastVec.z),
                    end: new THREE.Vector3(1000, lastVec.y, lastVec.z)
                };
            }
        }
        
        setInferenceGuide(newInferenceGuide);

        const validIntersection = (e.intersections as unknown as THREE.Intersection[]).find(i => i.face && (i.object.userData?.isShape || i.object.parent?.userData?.isShape));
        const snap = getSnapPoint(point, raycaster.ray, shapes, tool, newInferenceGuide, guideLines, validIntersection);

        // For DRAW_RECT after the first point is placed, an edge snap locks the
        // cursor onto the edge line. When start and end lie on the same edge the
        // rectangle collapses to a straight-line preview. Fall back to grid snap
        // so the cursor remains free to move in both axes.
        let effectiveSnap = snap;
        if (tool === ToolType.DRAW_RECT && drawPointsRef.current.length >= 1 && snap.type === 'edge') {
            const gridPos = new THREE.Vector3(
                Math.round(point.x / SNAP_GRID) * SNAP_GRID,
                point.y,
                Math.round(point.z / SNAP_GRID) * SNAP_GRID
            );
            effectiveSnap = { position: gridPos, type: 'grid', distance: snap.distance };
        }

        setSnapInfo(effectiveSnap);
        cursorPosRef.current = effectiveSnap.position.clone();
        setCursorPos(effectiveSnap.position);
    }, [tool, selectionBox.start, shapes, raycaster.ray, drawPoints, guideLines]);

    const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
        if (tool === ToolType.PUSH_PULL || tool === ToolType.ROTATE || tool === ToolType.HAND || tool === ToolType.SELECT) return;
        if (e.button !== 0) return;
    }, [tool]);
    
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
             if ((e.target as HTMLElement)?.dataset?.measurementPanel === 'true') return;
             if ([ToolType.SELECT, ToolType.PUSH_PULL, ToolType.ROTATE, ToolType.HAND].includes(tool)) return;
             if (e.key === 'Escape') {
                 setDrawPoints([]);
                 setDrawingParentId(undefined);
                 setTypedInput('');
                 setMeasurement('');
                 if (tool === ToolType.GUIDE_LINE) {
                     setGuideCreation({ active: false, start: new THREE.Vector3(), current: new THREE.Vector3(), edge: null });
                 }
             } else if (e.key === 'Backspace' || e.key === 'Delete') {
                 if (drawPoints.length > 0) {
                     setDrawPoints(prev => prev.slice(0, -1));
                 }
             } else if (/^[0-9.,]$/.test(e.key)) {
                 setTypedInput(prev => prev + e.key);
             } else if (e.key === 'Enter') {
                 handleInputSubmit();
             }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [tool, drawPoints, handleInputSubmit, setMeasurement]);

    // Dispatch measurement display data to the fixed panel in Viewport
    useEffect(() => {
        let label = '';
        let placeholder = '';
        let visible = false;

        if (tool === ToolType.DRAW_LINE && drawPoints.length > 0) {
            const start = drawPoints[drawPoints.length - 1];
            if (start) {
                const dist = new THREE.Vector3(start.x, start.y, start.z).distanceTo(cursorPos);
                label = '長度';
                placeholder = formatValue(dist);
                visible = true;
            }
        } else if (tool === ToolType.DRAW_RECT && drawPoints.length > 0) {
            const start = drawPoints[0];
            if (start) {
                const startV = new THREE.Vector3(start.x, start.y, start.z);
                const { right, top: topVec } = getLocalBasis(drawingNormal);
                const diff = cursorPos.clone().sub(startV);
                const w = Math.abs(diff.dot(right));
                const h = Math.abs(diff.dot(topVec));
                label = '長, 寬 (逗號分隔)';
                placeholder = `${formatValue(w)}, ${formatValue(h)}`;
                visible = true;
            }
        } else if (tool === ToolType.DRAW_CIRCLE && drawPoints.length > 0) {
            const start = drawPoints[0];
            if (start) {
                const dist = new THREE.Vector3(start.x, start.y, start.z).distanceTo(cursorPos);
                label = '半徑';
                placeholder = formatValue(dist);
                visible = true;
            }
        } else if (tool === ToolType.DIMENSION && drawPoints.length > 0) {
            const start = drawPoints[drawPoints.length - 1];
            if (start) {
                const dist = new THREE.Vector3(start.x, start.y, start.z).distanceTo(cursorPos);
                label = '距離';
                placeholder = formatValue(dist);
                visible = true;
            }
        } else if (tool === ToolType.GUIDE_LINE && guideCreation.active) {
            let dist = 0;
            if (guideCreation.edge) {
                const p1 = guideCreation.edge[0].clone();
                const p2 = guideCreation.edge[1].clone();
                if (Math.abs(p1.y - p2.y) < 0.01) { p1.y = cursorPos.y; p2.y = cursorPos.y; }
                const edgeVec = new THREE.Vector3().subVectors(p2, p1);
                const v = new THREE.Vector3().subVectors(cursorPos, p1);
                const d = edgeVec.clone().normalize();
                const projectedV = d.multiplyScalar(v.dot(d));
                const rejection = new THREE.Vector3().subVectors(v, projectedV);
                dist = rejection.length();
            } else {
                const dx = Math.abs(cursorPos.x - guideCreation.start.x);
                const dz = Math.abs(cursorPos.z - guideCreation.start.z);
                dist = dx > dz ? dx : dz;
            }
            label = guideCreation.edge ? '偏移距離' : '距離';
            placeholder = formatValue(dist);
            visible = true;
        }

        if (visible) {
            window.dispatchEvent(new CustomEvent('measurementDisplayUpdate', {
                detail: { visible: true, label, typedInput, placeholder }
            }));
        }
    }, [tool, drawPoints, cursorPos, typedInput, guideCreation, formatValue]);

    // Hide panel when tool changes
    useEffect(() => {
        window.dispatchEvent(new CustomEvent('measurementDisplayUpdate', {
            detail: { visible: false, label: '', typedInput: '', placeholder: '' }
        }));
    }, [tool]);

    // Listen for typed input from the fixed panel
    useEffect(() => {
        const onPanelInput = (e: Event) => setTypedInput((e as CustomEvent).detail.value);
        const onPanelSubmit = () => handleInputSubmit();
        const onPanelEscape = () => {
            setDrawPoints([]);
            setTypedInput('');
            setMeasurement('');
            setGuideCreation({ active: false, start: new THREE.Vector3(), current: new THREE.Vector3(), edge: null });
        };
        window.addEventListener('measurementPanelInput', onPanelInput);
        window.addEventListener('measurementPanelSubmit', onPanelSubmit);
        window.addEventListener('measurementPanelEscape', onPanelEscape);
        return () => {
            window.removeEventListener('measurementPanelInput', onPanelInput);
            window.removeEventListener('measurementPanelSubmit', onPanelSubmit);
            window.removeEventListener('measurementPanelEscape', onPanelEscape);
        };
    }, [handleInputSubmit, setMeasurement]);

    return {
        drawPoints,
        cursorPos,
        snapInfo,
        setCursorPos,
        setSnapInfo,
        isDragging,
        drawingHeight,
        typedInput,
        guideCreation,
        drawingNormal,
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handleClick,
        selectionBox,
        inferenceGuide,
        setInferenceGuide
    };
};

const BackgroundImageRenderer: React.FC = () => {
    const { backgroundImage, backgroundOpacity, backgroundScale, backgroundPosition } = useApp();
    const textureLoader = useMemo(() => new THREE.TextureLoader(), []);
    const [texture, setTexture] = useState<THREE.Texture | null>(null);
    const [aspectRatio, setAspectRatio] = useState(1);
    const currentTextureRef = useRef<THREE.Texture | null>(null);

    useEffect(() => {
        let cancelled = false;
        if (backgroundImage) {
            textureLoader.load(backgroundImage, (tex) => {
                if (cancelled) { tex.dispose(); return; }
                tex.colorSpace = THREE.SRGBColorSpace;
                if (currentTextureRef.current) currentTextureRef.current.dispose();
                currentTextureRef.current = tex;
                setTexture(tex);
                setAspectRatio(tex.image.height > 0 ? tex.image.width / tex.image.height : 1);
            });
        } else {
            if (currentTextureRef.current) { currentTextureRef.current.dispose(); currentTextureRef.current = null; }
            setTexture(null);
        }
        return () => { cancelled = true; };
    }, [backgroundImage, textureLoader]);

    useEffect(() => {
        return () => {
            if (currentTextureRef.current) { currentTextureRef.current.dispose(); currentTextureRef.current = null; }
        };
    }, []);

    if (!texture) return null;

    // Use a large base size, e.g., 10 units high. The width is determined by aspect ratio.
    // The scale will adjust this base size.
    const baseHeight = 10;
    const baseWidth = baseHeight * aspectRatio;

    return (
        <mesh 
            position={[backgroundPosition[0], -0.002, backgroundPosition[2]]} 
            rotation={[-Math.PI / 2, 0, 0]}
            scale={[backgroundScale, backgroundScale, 1]}
            renderOrder={-1}
        >
            <planeGeometry args={[baseWidth, baseHeight]} />
            <meshBasicMaterial 
                map={texture} 
                transparent 
                opacity={backgroundOpacity / 100} 
                depthWrite={false}
                blending={THREE.MultiplyBlending}
                premultipliedAlpha={true}
            />
        </mesh>
    );
};

const ContextLossRecovery: React.FC = () => {
    const { gl } = useThree();
    useEffect(() => {
        const canvas = gl.domElement;
        const onLost = (e: Event) => {
            (e as WebGLContextEvent).preventDefault();
            console.warn('[WebGL] context lost — triggering canvas remount');
            // Remounting the Canvas is the only reliable recovery for R3F:
            // resetState+invalidate cannot re-upload GPU resources that were wiped.
            window.dispatchEvent(new CustomEvent('r3f:contextLost'));
        };
        canvas.addEventListener('webglcontextlost', onLost, false);
        return () => {
            canvas.removeEventListener('webglcontextlost', onLost);
        };
    }, [gl]);
    return null;
};

const ExportLabelRegistrar: React.FC = () => {
    const { camera } = useThree();
    const { shapes, formatValue, setExportOverlay } = useApp();
    const shapesRef = useRef(shapes);
    const cameraRef = useRef(camera);
    const fmtRef = useRef(formatValue);
    useEffect(() => { shapesRef.current = shapes; }, [shapes]);
    useEffect(() => { cameraRef.current = camera; }, [camera]);
    useEffect(() => { fmtRef.current = formatValue; }, [formatValue]);

    useEffect(() => {
        setExportOverlay((src: HTMLCanvasElement) => {
            const out = document.createElement('canvas');
            out.width = src.width;
            out.height = src.height;
            const ctx = out.getContext('2d');
            if (!ctx) return src;
            ctx.drawImage(src, 0, 0);

            const cam = cameraRef.current;
            const fmt = fmtRef.current;
            const tmpVec = new THREE.Vector3();

            shapesRef.current
                .filter((s) => s.type === 'dimension' && s.points && s.points.length >= 3)
                .forEach((shape) => {
                    const pts = shape.points!;
                    if (!pts[0] || !pts[1] || !pts[2]) return;
                    const p1 = new THREE.Vector3(pts[0].x, pts[0].y, pts[0].z);
                    const p2 = new THREE.Vector3(pts[1].x, pts[1].y, pts[1].z);
                    const p3 = new THREE.Vector3(pts[2].x, pts[2].y, pts[2].z);
                    const v12 = new THREE.Vector3().subVectors(p2, p1);
                    const v13 = new THREE.Vector3().subVectors(p3, p1);
                    const lenSq = v12.lengthSq();
                    if (lenSq === 0) return;
                    const offset = new THREE.Vector3().subVectors(
                        p3, p1.clone().add(v12.clone().multiplyScalar(v13.dot(v12) / lenSq))
                    );
                    const mid = new THREE.Vector3()
                        .addVectors(p1.clone().add(offset), p2.clone().add(offset))
                        .multiplyScalar(0.5);

                    tmpVec.copy(mid).project(cam);
                    const sx = (tmpVec.x + 1) * out.width / 2;
                    const sy = (-tmpVec.y + 1) * out.height / 2;

                    const text = fmt(p1.distanceTo(p2));
                    const fs = Math.max(12, Math.round(out.height * 0.022));
                    ctx.font = `bold ${fs}px monospace`;
                    const tw = ctx.measureText(text).width;
                    const px = fs * 0.5;
                    const py = fs * 0.35;
                    const bw = tw + px * 2;
                    const bh = fs + py * 2;

                    ctx.fillStyle = '#0ea5e9';
                    ctx.fillRect(sx - bw / 2 - 2, sy - bh / 2 - 2, bw + 4, bh + 4);
                    ctx.fillStyle = 'rgba(255,255,255,0.97)';
                    ctx.fillRect(sx - bw / 2, sy - bh / 2, bw, bh);
                    ctx.fillStyle = '#1e293b';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(text, sx, sy);
                });

            return out;
        });
        return () => setExportOverlay(null);
    }, [setExportOverlay]);

    return null;
};

const SceneContent: React.FC = () => {
    const {
        shapes, tool, selectedIds, currentView, setCurrentView,
        guideLines, updateShapes, activeLayerId, unit, layers, selectShape, updateShape,
        setMeasurement, isCalibrating, setIsCalibrating, backgroundScale, setBackgroundScale, formatValue, removeShape,
        replaceShapes, showAxes,
    } = useApp();
    
    // Refs
    const shapeRefs = useRef<Record<string, THREE.Group | null>>({});
    const setShapeRef = useCallback((id: string, ref: THREE.Group | null) => {
        shapeRefs.current[id] = ref;
    }, []);

    // Managers
    const [dragging, setDragging] = useState(false);

    const [alignmentLines, setAlignmentLines] = useState<AlignmentLine[]>([]);
    const [calibrationPoints, setCalibrationPoints] = useState<THREE.Vector3[]>([]);
    
    const { ppState, handlePointerMove: ppMove, handlePointerDown: ppDown, handlePointerUp: ppUp, isDragging: isPPDragging, tempShape } = usePushPullManager();
    const drawingManager = useDrawingManager();
    const { rotatePhase, handleRotateMove, handleClick: rotateClick, rotateUI } = useRotateManager(shapeRefs, drawingManager.snapInfo);
    const { raycaster, camera } = useThree();

    useFrame(() => {
        if (raycaster.params.Line) {
            if (tool === ToolType.ERASER) {
                // Adaptive threshold: scale with camera distance from origin so the
                // hit area stays ~30px on screen at any zoom level or view angle.
                const camDist = Math.max(1, camera.position.length());
                raycaster.params.Line.threshold = Math.max(0.3, Math.min(camDist * 0.05, 4.0));
            } else {
                raycaster.params.Line.threshold = 0.1;
            }
        }
    });

    const pushPullHandlers = useMemo(() => ({ handlePointerDown: ppDown, handlePointerUp: ppUp, handlePointerMove: ppMove }), [ppDown, ppUp, ppMove]);
    const drawingHandlers = useMemo(() => ({ handlePointerDown: drawingManager.handlePointerDown, handlePointerUp: drawingManager.handlePointerUp, handleClick: drawingManager.handleClick, handlePointerMove: drawingManager.handlePointerMove }), [drawingManager.handlePointerDown, drawingManager.handlePointerUp, drawingManager.handleClick, drawingManager.handlePointerMove]);
    const rotateHandlers = useMemo(() => ({ handleClick: rotateClick, handlePointerMove: handleRotateMove }), [rotateClick, handleRotateMove]);

    // Combined Pointer Move
    const handlePointerMove = useCallback((e: ThreeEvent<PointerEvent>) => {
        if (isCalibrating) {
            drawingManager.setCursorPos(e.point);
            return;
        }
        // Skip expensive snap computation while the transform gizmo is being dragged
        if (!dragging) drawingManager.handlePointerMove(e);
        if (tool === ToolType.PUSH_PULL) ppMove(e);
        else if (tool === ToolType.ROTATE) handleRotateMove(e);
    }, [isCalibrating, dragging, tool, ppMove, handleRotateMove, drawingManager]);

    // Combined Background Click
    const handleBgClick = useCallback((e: ThreeEvent<MouseEvent>) => {
        if (isCalibrating) {
            e.stopPropagation();
            const newPoints = [...calibrationPoints, e.point.clone()];
            setCalibrationPoints(newPoints);
            
            if (newPoints.length === 2) {
                const dist = newPoints[0].distanceTo(newPoints[1]);
                window.dispatchEvent(new CustomEvent('showCalibrationModal', { detail: { dist } }));
                
                setCalibrationPoints([]);
                setIsCalibrating(false);
            }
            return;
        }

        if (tool === ToolType.ERASER) {
            return;
        }

        if (tool === ToolType.ROTATE) {
            rotateClick(e);
        } else {
            drawingManager.handleClick(e);
        }
    }, [isCalibrating, calibrationPoints, formatValue, unit, setBackgroundScale, setIsCalibrating, tool, drawingManager, rotateClick]);

    return (
        <>
            <ContextLossRecovery />
            <ExportLabelRegistrar />
            <color attach="background" args={['#f8fafc']} />
            <ambientLight intensity={0.6} />
            <directionalLight position={[10, 20, 10]} intensity={0.7} />

            <CameraHandler view={currentView} onFinished={() => setCurrentView(null)} />
            
            <OrbitControls
                makeDefault
                enableRotate={tool === ToolType.HAND && !isCalibrating}
                enablePan={true}
                enableZoom={true}
                zoomToCursor
                maxPolarAngle={Math.PI / 2 - 0.05}
            />

            <BackgroundImageRenderer />

            <InteractionLayer 
                shapes={shapes}
                tool={tool}
                setCursorPos={drawingManager.setCursorPos}
                setSnapInfo={drawingManager.setSnapInfo}
                cursorPos={drawingManager.cursorPos}
                snapInfo={drawingManager.snapInfo}
                drawPoints={drawingManager.drawPoints}
                isDragging={drawingManager.isDragging}
                drawingHeight={drawingManager.drawingHeight}
                typedInput={drawingManager.typedInput}
                guideCreating={drawingManager.guideCreation}
                rotatePhase={rotatePhase}
                drawingNormal={drawingManager.drawingNormal}
                isGizmoDragging={dragging}
                inferenceGuide={drawingManager.inferenceGuide}
                setInferenceGuide={drawingManager.setInferenceGuide}
                onPointerDown={drawingManager.handlePointerDown}
                onPointerUp={drawingManager.handlePointerUp}
                onMove={handlePointerMove}
                onClick={handleBgClick}
                selectionBox={drawingManager.selectionBox}
            />

            {isCalibrating && calibrationPoints.length === 1 && (
                <SimpleLine 
                    points={[calibrationPoints[0], drawingManager.cursorPos]} 
                    color="#ef4444" 
                    dashed 
                    lineWidth={2} 
                    depthTest={false} 
                    transparent={true}
                    renderOrder={999}
                />
            )}

            <group 
                onPointerMove={handlePointerMove}
                onPointerUp={(e) => {
                    if (tool === ToolType.PUSH_PULL) ppUp();
                    drawingManager.handlePointerUp(e);
                }}
            >
                {/* Shapes */}
                {shapes.map(shape => {
                    // Filter hidden layers here (outside ShapeRenderer) to avoid
                    // conditional hook call violations that cause white-screen crashes.
                    const parentLayer = layers.find(l => l.id === shape.layerId);
                    if (parentLayer && !parentLayer.visible) return null;

                    const isDraggingTop = ppState.mode === 'top' && ppState.hoveredShapeId === shape.id && !!ppState.dragStartPoint;
                    const dragScaleY = (isDraggingTop && ppState.dragHeight !== undefined && shape.height > 0) ? ppState.dragHeight / shape.height : 1;
                    return (
                    <ShapeRenderer
                        key={shape.id}
                        shape={shape} 
                        isSelected={selectedIds.includes(shape.id)}
                        isDraggingTop={isDraggingTop}
                        dragScaleY={dragScaleY}
                        pushPullHandlers={pushPullHandlers}
                        drawingHandlers={drawingHandlers}
                        rotateHandlers={rotateHandlers}
                        setDraggingState={setDragging}
                        onShapeRef={setShapeRef}
                        shapeRefs={shapeRefs}
                        setAlignmentLines={setAlignmentLines}
                        setSnapInfo={drawingManager.setSnapInfo}
                        setMeasurement={setMeasurement}
                        isSnapHovered={drawingManager.snapInfo?.snapObjectId === shape.id}

                        // Context props
                        unit={unit}
                        tool={tool}
                        updateShapes={updateShapes}
                        layers={layers}
                        selectedIds={selectedIds}
                        shapes={shapes}
                        selectShape={selectShape}
                        updateShape={updateShape}
                        removeShape={removeShape}
                        guideLines={guideLines}
                    />
                )})}

                {/* Temp Shape during PushPull */}
                {tempShape && (
                     <ShapeRenderer
                        shape={tempShape}
                        isSelected={true}
                        isDraggingTop={false}
                        dragScaleY={1}
                        pushPullHandlers={pushPullHandlers}
                        drawingHandlers={drawingHandlers}
                        rotateHandlers={rotateHandlers}
                        setDraggingState={setDragging}
                        onShapeRef={() => {}} // No ref needed for temp
                        shapeRefs={shapeRefs}
                        setAlignmentLines={() => {}}
                        setSnapInfo={drawingManager.setSnapInfo}
                        setMeasurement={setMeasurement}
                        isSnapHovered={false}
                        
                        // Context props
                        unit={unit}
                        tool={tool}
                        updateShapes={updateShapes}
                        layers={layers}
                        selectedIds={selectedIds}
                        shapes={shapes}
                        selectShape={selectShape}
                        updateShape={updateShape}
                        removeShape={removeShape}
                    />
                )}
            </group>
            
            <SelectionGizmo setDragging={setDragging} shapeRefs={shapeRefs} />
            <RotationGizmo pivot={rotateUI.pivot} axis={rotateUI.axis} axisPoint1={rotateUI.axisPoint1} axisPreviewEnd={rotateUI.axisPreviewEnd} />
            {showAxes && <WorldAxes />}
            <GuideLinesRenderer lines={guideLines} />
            <AlignmentLinesRenderer lines={alignmentLines} />

            
            <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
                <GizmoViewport axisColors={['#9d4b4b', '#2f7f4f', '#3b5b9d']} labelColor="white" />
            </GizmoHelper>
        </>
    );
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
class CanvasErrorBoundary extends (React.Component as any) {
    state = { hasError: false, error: null as Error | null, resetKey: 0 };
    static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
    componentDidCatch(error: Error) {
        console.error('[CanvasErrorBoundary]', error);
        // Auto-reset after 1.5s for transient errors (e.g. brief invalid geometry during state update)
        setTimeout(() => {
            this.setState((prev: { resetKey: number }) => ({ hasError: false, error: null, resetKey: prev.resetKey + 1 }));
        }, 1500);
    }
    render() {
        if (this.state.hasError) {
            return (
                <div className="w-full h-full flex flex-col items-center justify-center bg-slate-100 gap-4">
                    <div className="bg-white rounded-xl shadow-lg border border-amber-300 px-8 py-6 flex flex-col items-center gap-3 max-w-sm">
                        <span className="text-3xl">⚠️</span>
                        <p className="text-sm font-bold text-slate-700 text-center">繪圖引擎暫時錯誤，正在自動恢復…</p>
                        {this.state.error && (
                            <p className="text-xs text-slate-400 text-center">{(this.state.error as Error).message}</p>
                        )}
                        <button
                            className="mt-2 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-bold rounded-lg transition-colors"
                            onClick={() => window.location.reload()}
                        >
                            強制重新載入
                        </button>
                    </div>
                </div>
            );
        }
        // Wrap children in a keyed Fragment so Canvas remounts cleanly after reset
        return (
            <React.Fragment key={this.state.resetKey}>
                {(this.props as { children: React.ReactNode }).children}
            </React.Fragment>
        );
    }
}

const Viewport: React.FC = () => {
    const { tool, unit, formatValue, backgroundScale, setBackgroundScale } = useApp();
    const [canvasKey, setCanvasKey] = useState(0);
    const [selectionBox, setSelectionBox] = useState<{ start: THREE.Vector2 | null, current: THREE.Vector2 | null }>({ start: null, current: null });
    const [calibrationModal, setCalibrationModal] = useState<{ dist: number } | null>(null);
    const [calibrationInput, setCalibrationInput] = useState('');
    const [measureDisplay, setMeasureDisplay] = useState<{
        visible: boolean; label: string; typedInput: string; placeholder: string;
    }>({ visible: false, label: '', typedInput: '', placeholder: '' });

    const panelInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const handler = () => {
            console.warn('[Viewport] WebGL context lost — remounting Canvas');
            setTimeout(() => setCanvasKey(k => k + 1), 100);
        };
        window.addEventListener('r3f:contextLost', handler);
        return () => window.removeEventListener('r3f:contextLost', handler);
    }, []);

    useEffect(() => {
        const handler = (e: Event) => setMeasureDisplay((e as CustomEvent).detail);
        window.addEventListener('measurementDisplayUpdate', handler);
        return () => window.removeEventListener('measurementDisplayUpdate', handler);
    }, []);

    // Listen for custom events dispatched from SceneContent
    useEffect(() => {
        const handleSelectionBoxUpdate = (e: CustomEvent) => {
            setSelectionBox(e.detail);
        };
        const handleShowCalibrationModal = (e: CustomEvent) => {
            setCalibrationModal(e.detail);
            setCalibrationInput('');
        };
        window.addEventListener('selectionBoxUpdate', handleSelectionBoxUpdate as EventListener);
        window.addEventListener('showCalibrationModal', handleShowCalibrationModal as EventListener);
        return () => {
            window.removeEventListener('selectionBoxUpdate', handleSelectionBoxUpdate as EventListener);
            window.removeEventListener('showCalibrationModal', handleShowCalibrationModal as EventListener);
        };
    }, []);

    const handleCalibrationSubmit = () => {
        if (!calibrationModal) return;
        const realDist = parseFloat(calibrationInput);
        if (!isNaN(realDist) && realDist > 0) {
            const realDistInMeters = unit === 'cm' ? realDist / 100 : realDist;
            setBackgroundScale(backgroundScale * (realDistInMeters / calibrationModal.dist));
            setCalibrationModal(null);
        } else {
            alert("請輸入有效的數字");
        }
    };

    return (
        <div 
            className="w-full h-full bg-slate-100 relative"
            style={{ cursor: tool === ToolType.ERASER ? 'crosshair' : 'default' }}
        >
             <CanvasErrorBoundary>
             <div id="r3f-main" style={{ width: '100%', height: '100%' }}>
             <React.Fragment key={canvasKey}>
             <Canvas
                dpr={[1, 1.5]}
                camera={{ position: [5, 5, 5], fov: 50 }}
                gl={{ preserveDrawingBuffer: true, antialias: true, powerPreference: 'high-performance' }}
                raycaster={{ params: { Line: { threshold: 0.1 } } as any }}
                onPointerMissed={(e) => {
                    window.dispatchEvent(new CustomEvent('canvasPointerMissed', { detail: e }));
                }}
             >
                <SceneContent />
             </Canvas>
             </React.Fragment>
             </div>
             </CanvasErrorBoundary>
             {selectionBox.start && selectionBox.current && (
                 <SelectionBox start={selectionBox.start} end={selectionBox.current} />
             )}
             {measureDisplay.visible && (
                 <div className="absolute bottom-4 right-4 z-50 flex items-center gap-2 bg-white/95 backdrop-blur-sm rounded-lg border-2 border-indigo-300 shadow-lg px-3 py-2 pointer-events-auto">
                     <span className="text-xs font-bold text-indigo-500 uppercase tracking-wide whitespace-nowrap">
                         {measureDisplay.label}
                     </span>
                     <input
                         ref={panelInputRef}
                         data-measurement-panel="true"
                         type="text"
                         value={measureDisplay.typedInput}
                         placeholder={measureDisplay.placeholder}
                         onChange={(e) => {
                             const val = e.target.value.replace(/[^0-9.,\s]/g, '');
                             window.dispatchEvent(new CustomEvent('measurementPanelInput', { detail: { value: val } }));
                         }}
                         onKeyDown={(e) => {
                             if (e.key === 'Enter') { window.dispatchEvent(new CustomEvent('measurementPanelSubmit')); e.preventDefault(); }
                             if (e.key === 'Escape') { window.dispatchEvent(new CustomEvent('measurementPanelEscape')); e.preventDefault(); }
                         }}
                         className="min-w-[160px] bg-slate-50 border border-slate-200 rounded px-2 py-0.5 text-sm font-mono text-slate-800 text-right focus:outline-none focus:border-indigo-400 focus:bg-white"
                     />
                 </div>
             )}
             {calibrationModal && (
                 <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/20 backdrop-blur-sm pointer-events-auto">
                     <div className="bg-white rounded-xl shadow-xl border border-slate-200 p-6 w-[400px] flex flex-col gap-4">
                         <h3 className="text-lg font-semibold text-slate-800">校正底圖比例</h3>
                         <div className="text-sm text-slate-600">
                             您畫的線段在畫布上的長度為 <span className="font-medium text-blue-600">{formatValue(calibrationModal.dist)}</span>。
                         </div>
                         <div className="flex flex-col gap-2">
                             <label className="text-sm font-medium text-slate-700">
                                 請輸入這段線段在實際空間中的長度 (單位: {unit === 'cm' ? '公分' : '公尺'})
                             </label>
                             <input 
                                 type="number" 
                                 value={calibrationInput}
                                 onChange={(e) => setCalibrationInput(e.target.value)}
                                 onKeyDown={(e) => {
                                     if (e.key === 'Enter') handleCalibrationSubmit();
                                     if (e.key === 'Escape') setCalibrationModal(null);
                                 }}
                                 className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                 placeholder="例如: 100"
                                 autoFocus
                             />
                         </div>
                         <div className="flex justify-end gap-3 mt-2">
                             <button 
                                 onClick={() => setCalibrationModal(null)}
                                 className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-md transition-colors"
                             >
                                 取消
                             </button>
                             <button 
                                 onClick={handleCalibrationSubmit}
                                 className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
                             >
                                 確認
                             </button>
                         </div>
                     </div>
                 </div>
             )}
        </div>
    );
};

export default Viewport;
