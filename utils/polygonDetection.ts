import * as THREE from 'three';
import { IShape, IPoint } from '../types';

const eps = 1e-4;
const isEq = (p1: THREE.Vector3, p2: THREE.Vector3) => p1.distanceTo(p2) < eps;

// ---------------------------------------------------------------------------
// Erased-polygon blocking
// When the user erases a flat, its world-space signature (centroid + area) is
// stored here. updatePolygons will not recreate a polygon whose signature
// matches a blocked entry, preventing immediate re-formation of erased areas.
// Each entry expires after 30 seconds so the user can re-enclose the area later.
// ---------------------------------------------------------------------------
const erasedSigs = new Set<string>();

function flatSigKey(cx: number, cz: number, area: number): string {
    // Round to 2 decimal places to tolerate minor floating-point drift
    return `${Math.round(cx * 100) / 100}:${Math.round(cz * 100) / 100}:${Math.round(area * 100) / 100}`;
}

function computeFlatWorldSig(shape: IShape): { cx: number; cz: number; area: number } | null {
    if (shape.type !== 'flat' || shape.points.length < 3) return null;
    const worldPts = shape.points.map(p => transformPoint(p, shape));
    let cx = 0, cz = 0, signedArea = 0;
    for (let i = 0; i < worldPts.length; i++) {
        const p1 = worldPts[i];
        const p2 = worldPts[(i + 1) % worldPts.length];
        const cross = p1.x * p2.z - p2.x * p1.z;
        signedArea += cross;
        cx += (p1.x + p2.x) * cross;
        cz += (p1.z + p2.z) * cross;
    }
    signedArea /= 2;
    if (Math.abs(signedArea) < eps) return null;
    cx /= (6 * signedArea);
    cz /= (6 * signedArea);
    return { cx, cz, area: Math.abs(signedArea) };
}

/** Call this before erasing/decomposing a flat shape so updatePolygons
 *  won't immediately recreate it.
 *  The block is cleared automatically when the user draws a new line whose
 *  endpoints fall within 2m of the blocked area (see clearBlocksNearLine). */
export function blockErasedPolygon(shape: IShape): void {
    const sig = computeFlatWorldSig(shape);
    if (!sig) return;
    erasedSigs.add(flatSigKey(sig.cx, sig.cz, sig.area));
}

/**
 * Called from updatePolygons when a new line is drawn.
 * Any blocked polygon whose centroid is within `radius` metres of a line
 * endpoint is unblocked — the user is intentionally re-enclosing that area.
 */
function clearBlocksNearLine(p1: THREE.Vector3, p2: THREE.Vector3, radius = 2.0): void {
    if (erasedSigs.size === 0) return;
    for (const key of Array.from(erasedSigs)) {
        const parts = key.split(':');
        const cx = parseFloat(parts[0]);
        const cz = parseFloat(parts[1]);
        const dx1 = cx - p1.x, dz1 = cz - p1.z;
        const dx2 = cx - p2.x, dz2 = cz - p2.z;
        if (Math.sqrt(dx1 * dx1 + dz1 * dz1) < radius ||
            Math.sqrt(dx2 * dx2 + dz2 * dz2) < radius) {
            erasedSigs.delete(key);
        }
    }
}

// Find intersection of two 2D segments (ignoring Y)
function getIntersection(a1: THREE.Vector3, a2: THREE.Vector3, b1: THREE.Vector3, b2: THREE.Vector3): THREE.Vector3 | null {
    const denominator = (b2.z - b1.z) * (a2.x - a1.x) - (b2.x - b1.x) * (a2.z - a1.z);
    if (Math.abs(denominator) < eps) return null; // Parallel

    const ua = ((b2.x - b1.x) * (a1.z - b1.z) - (b2.z - b1.z) * (a1.x - b1.x)) / denominator;
    const ub = ((a2.x - a1.x) * (a1.z - b1.z) - (a2.z - a1.z) * (a1.x - b1.x)) / denominator;

    if (ua >= -eps && ua <= 1 + eps && ub >= -eps && ub <= 1 + eps) {
        return new THREE.Vector3(
            a1.x + ua * (a2.x - a1.x),
            0,
            a1.z + ua * (a2.z - a1.z)
        );
    }
    return null;
}

export function detectPolygons(segments: { p1: THREE.Vector3, p2: THREE.Vector3 }[]): THREE.Vector3[][] {
    if (segments.length === 0) return [];

    // Find all intersections and split segments
    const splitPoints: Map<number, THREE.Vector3[]> = new Map();
    for (let i = 0; i < segments.length; i++) {
        splitPoints.set(i, [segments[i].p1, segments[i].p2]);
    }

    for (let i = 0; i < segments.length; i++) {
        for (let j = i + 1; j < segments.length; j++) {
            const intPt = getIntersection(segments[i].p1, segments[i].p2, segments[j].p1, segments[j].p2);
            if (intPt) {
                splitPoints.get(i)!.push(intPt);
                splitPoints.get(j)!.push(intPt);
            }
        }
    }

    // Build unique vertices and adjacency list
    const vertices: THREE.Vector3[] = [];
    const getVertexId = (p: THREE.Vector3) => {
        for (let i = 0; i < vertices.length; i++) {
            if (isEq(vertices[i], p)) return i;
        }
        vertices.push(p);
        return vertices.length - 1;
    };

    const adj: Map<number, Set<number>> = new Map();
    const addEdge = (u: number, v: number) => {
        if (u === v) return;
        if (!adj.has(u)) adj.set(u, new Set());
        if (!adj.has(v)) adj.set(v, new Set());
        adj.get(u)!.add(v);
        adj.get(v)!.add(u);
    };

    for (let i = 0; i < segments.length; i++) {
        const pts = splitPoints.get(i)!;
        // Sort points along the segment
        const base = segments[i].p1;
        pts.sort((a, b) => a.distanceTo(base) - b.distanceTo(base));
        
        // Remove duplicates
        const uniquePts: THREE.Vector3[] = [pts[0]];
        for (let k = 1; k < pts.length; k++) {
            if (!isEq(pts[k], uniquePts[uniquePts.length - 1])) {
                uniquePts.push(pts[k]);
            }
        }

        for (let k = 0; k < uniquePts.length - 1; k++) {
            const u = getVertexId(uniquePts[k]);
            const v = getVertexId(uniquePts[k+1]);
            addEdge(u, v);
        }
    }

    // Extract faces
    // For each vertex, sort neighbors by angle
    const edges: Map<number, number[]> = new Map(); // u -> sorted array of v
    for (const [u, neighbors] of adj.entries()) {
        const uPt = vertices[u];
        const sortedNeighbors = Array.from(neighbors).sort((a, b) => {
            const aPt = vertices[a];
            const bPt = vertices[b];
            const angleA = Math.atan2(aPt.z - uPt.z, aPt.x - uPt.x);
            const angleB = Math.atan2(bPt.z - uPt.z, bPt.x - uPt.x);
            return angleA - angleB;
        });
        edges.set(u, sortedNeighbors);
    }

    const visitedHalfEdges: Set<string> = new Set();
    const polygons: THREE.Vector3[][] = [];

    for (const [u, neighbors] of edges.entries()) {
        for (const v of neighbors) {
            const edgeKey = `${u}-${v}`;
            if (visitedHalfEdges.has(edgeKey)) continue;

            // Traverse face
            const face: number[] = [];
            let curr = u;
            let next = v;

            while (true) {
                const key = `${curr}-${next}`;
                if (visitedHalfEdges.has(key)) break; // Cycle complete or already visited
                visitedHalfEdges.add(key);
                face.push(curr);

                const nextNeighbors = edges.get(next)!;
                const currIdx = nextNeighbors.indexOf(curr);
                let nextNextIdx = currIdx - 1;
                if (nextNextIdx < 0) nextNextIdx = nextNeighbors.length - 1;
                
                const nextNext = nextNeighbors[nextNextIdx];
                curr = next;
                next = nextNext;

                if (curr === u && next === v) {
                    // Completed the cycle
                    break;
                }
            }

            if (face.length >= 3) {
                // Calculate signed area
                let area = 0;
                for (let k = 0; k < face.length; k++) {
                    const p1 = vertices[face[k]];
                    const p2 = vertices[face[(k + 1) % face.length]];
                    area += (p1.x * p2.z - p2.x * p1.z);
                }
                
                // If area > 0, it's an interior face (counter-clockwise)
                if (area > eps) {
                    polygons.push(face.map(idx => vertices[idx]));
                }
            }
        }
    }

    return polygons;
}

function transformPoint(p: IPoint, shape: IShape): THREE.Vector3 {
    const v = new THREE.Vector3(p.x, p.y, p.z);
    v.applyEuler(new THREE.Euler(shape.rotation[0], shape.rotation[1], shape.rotation[2]));
    v.add(new THREE.Vector3(shape.position[0], shape.position[1], shape.position[2]));
    return new THREE.Vector3(v.x, 0, v.z);
}

function isPointInPolygon(point: THREE.Vector3, polygon: THREE.Vector3[]) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, zi = polygon[i].z;
        const xj = polygon[j].x, zj = polygon[j].z;
        const intersect = ((zi > point.z) !== (zj > point.z)) &&
            (point.x < (xj - xi) * (point.z - zi) / (zj - zi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

export function updatePolygons(shapes: IShape[], replaceShapes: (removeIds: string[], addShapes: IShape[]) => void, activeLayerId: string, preserveIds: string[] = []) {
    // Exclude shapes drawn on a 3D surface (parentId set): they are in a rotated
    // local plane and their XZ projection has near-zero area, which causes them
    // to be incorrectly removed by the polygon detection pass.
    const lines = shapes.filter(s => s.type === 'line' && !s.groupId && !s.parentId && Math.abs((s.position?.[1] ?? 0)) < 0.01);
    const existingFlats = shapes.filter(s => s.type === 'flat' && !s.groupId && !s.parentId);

    const segments: { p1: THREE.Vector3, p2: THREE.Vector3 }[] = [];

    // Hand-drawn line segments
    // Also clear any erased-polygon blocks whose centroid is near a line endpoint,
    // signalling that the user is intentionally re-enclosing that area.
    lines.forEach(line => {
        for (let i = 0; i < line.points.length - 1; i++) {
            const p1 = transformPoint(line.points[i], line);
            const p2 = transformPoint(line.points[i+1], line);
            if (p1.distanceTo(p2) > eps) {
                segments.push({ p1, p2 });
                clearBlocksNearLine(p1, p2);
            }
        }
    });

    // Exterior edges from flat shapes: edges that are NOT fully covered by
    // another flat shape's edge. Adjacent flats share edges that cancel each
    // other out; only the outward-facing (uncovered) edges remain.
    // These participate in forming new enclosed areas together with lines or
    // other flat edges (e.g. a center gap surrounded by four rectangles).
    const flatWorldPoints = existingFlats.map(f => ({
        shape: f,
        pts: f.points.map(p => transformPoint(p, f))
    }));

    const allFlatEdges: { p1: THREE.Vector3, p2: THREE.Vector3, shapeId: string }[] = [];
    for (const fw of flatWorldPoints) {
        for (let i = 0; i < fw.pts.length; i++) {
            allFlatEdges.push({
                p1: fw.pts[i],
                p2: fw.pts[(i + 1) % fw.pts.length],
                shapeId: fw.shape.id
            });
        }
    }

    for (const fw of flatWorldPoints) {
        // Build the edge list of every OTHER flat once per shape (not per edge)
        const otherEdges = allFlatEdges.filter(e => e.shapeId !== fw.shape.id);
        for (let i = 0; i < fw.pts.length; i++) {
            const p1 = fw.pts[i];
            const p2 = fw.pts[(i + 1) % fw.pts.length];
            if (p1.distanceTo(p2) <= eps) continue;
            // AABB pre-filter: only pass edges whose bounding box overlaps this edge
            const minX = Math.min(p1.x, p2.x) - eps;
            const maxX = Math.max(p1.x, p2.x) + eps;
            const minZ = Math.min(p1.z, p2.z) - eps;
            const maxZ = Math.max(p1.z, p2.z) + eps;
            const candidates = otherEdges.filter(e =>
                Math.max(e.p1.x, e.p2.x) >= minX && Math.min(e.p1.x, e.p2.x) <= maxX &&
                Math.max(e.p1.z, e.p2.z) >= minZ && Math.min(e.p1.z, e.p2.z) <= maxZ
            );
            // Only add edge if it is NOT completely covered by another flat's edge
            if (!isSegmentCovered(p1, p2, candidates)) {
                segments.push({ p1, p2 });
            }
        }
    }

    const detectedPolygons = detectPolygons(segments);

    const getCenterAndArea = (pts: IPoint[]) => {
        let cx = 0, cz = 0, signedArea = 0;
        for (let i = 0; i < pts.length; i++) {
            const p1 = pts[i];
            const p2 = pts[(i + 1) % pts.length];
            const cross = (p1.x * p2.z - p2.x * p1.z);
            signedArea += cross;
            cx += (p1.x + p2.x) * cross;
            cz += (p1.z + p2.z) * cross;
        }
        signedArea = signedArea / 2;
        if (Math.abs(signedArea) < eps) return { cx: 0, cz: 0, area: 0 };
        cx = cx / (6 * signedArea);
        cz = cz / (6 * signedArea);
        return { cx, cz, area: Math.abs(signedArea) };
    };

    const existingSignatures = existingFlats.map(f => {
        const worldPts = f.points.map(p => transformPoint(p, f));
        return { id: f.id, sig: getCenterAndArea(worldPts), shape: f, matched: false };
    });

    const newFlats: IShape[] = [];
    const matchedOldFlatIds = new Set<string>();

    for (const poly of detectedPolygons) {
        const sig = getCenterAndArea(poly);
        if (sig.area < 0.01) continue; // Too small

        // Skip polygons the user has intentionally erased
        if (erasedSigs.has(flatSigKey(sig.cx, sig.cz, sig.area))) continue;

        let matchedOldShape: IShape | null = null;
        for (const ex of existingSignatures) {
            if (!ex.matched && 
                Math.abs(ex.sig.area - sig.area) < 0.01 && 
                Math.abs(ex.sig.cx - sig.cx) < 0.01 && 
                Math.abs(ex.sig.cz - sig.cz) < 0.01) {
                ex.matched = true;
                matchedOldShape = ex.shape;
                matchedOldFlatIds.add(ex.id);
                break;
            }
        }

        if (!matchedOldShape) {
            // Find which old shape it belongs to (for inheriting properties)
            let inheritedShape: IShape | null = null;
            const centerPt = new THREE.Vector3(sig.cx, 0, sig.cz);
            for (let i = existingSignatures.length - 1; i >= 0; i--) {
                const ex = existingSignatures[i];
                const worldPts = ex.shape.points.map(p => transformPoint(p, ex.shape));
                if (isPointInPolygon(centerPt, worldPts)) {
                    inheritedShape = ex.shape;
                    break;
                }
            }

            // Calculate center
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            poly.forEach(p => {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.z < minZ) minZ = p.z;
                if (p.z > maxZ) maxZ = p.z;
            });
            const cx = (minX + maxX) / 2;
            const cz = (minZ + maxZ) / 2;
            
            const localPoints = poly.map(p => ({ x: p.x - cx, y: 0, z: p.z - cz }));

            // Add new flat shape
            const newShape: IShape = {
                id: `poly-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                layerId: inheritedShape ? inheritedShape.layerId : activeLayerId,
                type: 'flat',
                points: localPoints,
                height: inheritedShape ? inheritedShape.height : 0,
                color: inheritedShape ? inheritedShape.color : '#cccccc',
                position: [cx, inheritedShape ? inheritedShape.position[1] : 0, cz],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                name: inheritedShape ? inheritedShape.name : '自動生成平面',
                groupId: inheritedShape ? inheritedShape.groupId : undefined
            };
            newFlats.push(newShape);
        }
    }

    // updatePolygons only ADDS new flat shapes — it never removes existing ones.
    // Removal of existing flats is handled by: user erasing, attemptGeometryCut, or decomposeFlat.
    // Reason: lines that formed existing flats are removed by linesToRemove (see below),
    // so re-running detection would not find them and would incorrectly remove the flats.
    const flatsToRemove: string[] = [];

    // Find lines that are completely covered by flat shapes
    const linesToRemove: string[] = [];
    // Use ALL existing flats (not just matched) so that lines along any flat edge are removed.
    const allFlats = [...existingFlats, ...newFlats];
    
    const flatEdges: { p1: THREE.Vector3, p2: THREE.Vector3 }[] = [];
    for (const f of allFlats) {
        const worldPts = f.points.map(p => transformPoint(p, f));
        for (let i = 0; i < worldPts.length; i++) {
            flatEdges.push({ p1: worldPts[i], p2: worldPts[(i + 1) % worldPts.length] });
        }
    }

    for (const line of lines) {
        let allCovered = true;
        for (let i = 0; i < line.points.length - 1; i++) {
            const p1 = transformPoint(line.points[i], line);
            const p2 = transformPoint(line.points[i+1], line);
            // AABB pre-filter: only test flat edges that could possibly cover this segment
            const minX = Math.min(p1.x, p2.x) - eps;
            const maxX = Math.max(p1.x, p2.x) + eps;
            const minZ = Math.min(p1.z, p2.z) - eps;
            const maxZ = Math.max(p1.z, p2.z) + eps;
            const candidates = flatEdges.filter(e =>
                Math.max(e.p1.x, e.p2.x) >= minX && Math.min(e.p1.x, e.p2.x) <= maxX &&
                Math.max(e.p1.z, e.p2.z) >= minZ && Math.min(e.p1.z, e.p2.z) <= maxZ
            );
            if (!isSegmentCovered(p1, p2, candidates)) {
                allCovered = false;
                break;
            }
        }
        if (allCovered && !preserveIds.includes(line.id)) {
            linesToRemove.push(line.id);
        }
    }

    const idsToRemove = [...flatsToRemove, ...linesToRemove];
    if (newFlats.length > 0 || idsToRemove.length > 0) {
        replaceShapes(idsToRemove, newFlats);
    }
}

function isSegmentCovered(A: THREE.Vector3, B: THREE.Vector3, edges: { p1: THREE.Vector3, p2: THREE.Vector3 }[]): boolean {
    const AB = new THREE.Vector3().subVectors(B, A);
    const lenSq = AB.lengthSq();
    if (lenSq < eps) return true;
    
    const abDir = AB.clone().normalize();

    const intervals: [number, number][] = [];

    for (const edge of edges) {
        const dir = new THREE.Vector3().subVectors(edge.p2, edge.p1);
        if (dir.lengthSq() < eps) continue;
        dir.normalize();
        
        const cross = new THREE.Vector3().crossVectors(abDir, dir);
        if (cross.lengthSq() > 1e-4) continue; // Not parallel

        const toEdge = new THREE.Vector3().subVectors(edge.p1, A);
        if (toEdge.lengthSq() > eps) {
            const toEdgeDir = toEdge.clone().normalize();
            const cross2 = new THREE.Vector3().crossVectors(abDir, toEdgeDir);
            if (cross2.lengthSq() > 1e-4) continue; // Parallel but not collinear
        }

        const t1 = new THREE.Vector3().subVectors(edge.p1, A).dot(AB) / lenSq;
        const t2 = new THREE.Vector3().subVectors(edge.p2, A).dot(AB) / lenSq;

        const minT = Math.min(t1, t2);
        const maxT = Math.max(t1, t2);

        if (maxT > -eps && minT < 1 + eps) {
            intervals.push([Math.max(0, minT), Math.min(1, maxT)]);
        }
    }

    if (intervals.length === 0) return false;

    intervals.sort((a, b) => a[0] - b[0]);
    let currentEnd = intervals[0][1];
    if (intervals[0][0] > eps) return false;

    for (let i = 1; i < intervals.length; i++) {
        if (intervals[i][0] > currentEnd + eps) {
            return false;
        }
        currentEnd = Math.max(currentEnd, intervals[i][1]);
    }

    return currentEnd >= 1 - eps;
}
