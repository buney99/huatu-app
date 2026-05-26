import * as THREE from 'three';
import { Evaluator, Brush, SUBTRACTION } from 'three-bvh-csg';

const baseGeo = new THREE.BoxGeometry(10, 10, 10);
const baseBrush = new Brush(baseGeo);
baseBrush.position.set(5, 5, 5);
baseBrush.updateMatrixWorld();

const opGeo = new THREE.BoxGeometry(5, 5, 5);
const opBrush = new Brush(opGeo);
opBrush.position.set(5, 10, 5);
opBrush.updateMatrixWorld();

const evaluator = new Evaluator();
const result = evaluator.evaluate(baseBrush, opBrush, SUBTRACTION);

console.log('Result position:', result.position);
console.log('Result geometry bounding box:', result.geometry.boundingBox);
result.geometry.computeBoundingBox();
console.log('Result geometry bounding box after compute:', result.geometry.boundingBox);
