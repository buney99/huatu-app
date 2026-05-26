import * as THREE from 'three';

const qGeoToGroup = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const qGroupToGeo = qGeoToGroup.clone().invert();

const localPos = new THREE.Vector3(10, 5, 0); // Right face of a box of size 20x10x20
const depth = 5;

const localQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
const brushQuat = qGroupToGeo.clone().multiply(localQuat).multiply(qGeoToGroup);

const brushPos = localPos.clone().applyQuaternion(qGroupToGeo);
const offset = new THREE.Vector3(0, 0, -depth - 0.01).applyQuaternion(brushQuat);
brushPos.add(offset);

console.log("brushPos:", brushPos);
console.log("brushQuat:", new THREE.Euler().setFromQuaternion(brushQuat));
