import * as THREE from 'three';

const qGeoToGroup = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const qGroupToGeo = qGeoToGroup.clone().invert();

const localPos = new THREE.Vector3(0, 10, 0); // Top face of a box of height 10
const depth = 5;

const localQuat = new THREE.Quaternion(); // Identity, hole drawn on top face
const brushQuat = qGroupToGeo.clone().multiply(localQuat).multiply(qGeoToGroup);

const brushPos = localPos.clone().applyQuaternion(qGroupToGeo);
const offset = new THREE.Vector3(0, 0, -depth - 0.01).applyQuaternion(brushQuat);
brushPos.add(offset);

console.log("brushPos:", brushPos);
console.log("brushQuat:", new THREE.Euler().setFromQuaternion(brushQuat));
