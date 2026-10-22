import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  BOOK, createLeafShape, hingeHeight, leafShape, stackHeights, turnAngle, visibleFaces,
  type LeafShape, type StackHeights, type VisibleFaces
} from './book-geometry.ts';
import { FOV, pivotFor, type Pose } from './camera.ts';
import { createPageLightMaterial } from './page-light-material.ts';
import { smoothstep, type BookState } from './timeline.ts';

// Book controller: the physical book in WebGL. Covers, page block, spine, ribbon
// and lighting are real geometry; the page *faces* are HTML (see faces.ts) and
// are represented here only by light meshes that shade them and cut them out.

const W = BOOK.pageW;
const H = BOOK.pageH;
const O = BOOK.overhang;
const BT = BOOK.board;
const GAP = BOOK.faceGap;
const SEGMENTS = BOOK.segments;
const SPINE_SEGMENTS = 16;
const KEY_OFFSET = new THREE.Vector3(-2.7, 3.3, 4.8);

export interface Quality {
  pixelRatio: number;
  shadows: boolean;
  shadowSize: number;
}

function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

/** Fine, slightly blotchy grain for the leather boards. */
function leatherGrain(): THREE.CanvasTexture {
  const texture = canvasTexture(256, 256, (ctx) => {
    const image = ctx.createImageData(256, 256);
    for (let i = 0; i < image.data.length; i += 4) {
      const value = 118 + Math.random() * 40 + (Math.random() < 0.04 ? -50 : 0);
      image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    ctx.globalAlpha = 0.5;
    ctx.filter = 'blur(1px)';
    ctx.drawImage(ctx.canvas, 0, 0);
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 4);
  return texture;
}

/** Spine label: gold title running down the spine. u = across the spine, v = along it. */
function spineLabel(): THREE.CanvasTexture {
  const texture = canvasTexture(128, 1024, (ctx) => {
    ctx.fillStyle = '#5b2f27';
    ctx.fillRect(0, 0, 128, 1024);
    ctx.fillStyle = '#c9a26a';
    ctx.fillRect(16, 70, 96, 3);
    ctx.fillRect(16, 951, 96, 3);
    ctx.save();
    ctx.translate(64, 512);
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 40px "Playfair Display", Georgia, serif';
    ctx.fillText('Anmol Bhandari', -70, 0);
    ctx.font = '500 20px "DM Mono", monospace';
    ctx.fillText('VOL. 01', 290, 0);
    ctx.restore();
  });
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Page-block material: paper with faint lines along the block's thickness. */
function pageEdgeMaterial(): { material: THREE.MeshStandardMaterial; height: { value: number } } {
  const height = { value: BOOK.block };
  const material = new THREE.MeshStandardMaterial({ color: '#ebe1cd', roughness: 0.92 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHeight = height;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uHeight;\nvarying float vEdgeZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdgeZ = position.z * uHeight;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vEdgeZ;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 0.93 + 0.07 * smoothstep(-0.3, 0.9, sin(vEdgeZ * 2400.0));');
  };
  return { material, height };
}

/** A flat rectangle whose uv.x is the distance from the spine (for the gutter shading). */
function facePlane(x0: number, x1: number, y0: number, y1: number, z: number, facing: 1 | -1): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, facing, 0, 0, facing, 0, 0, facing, 0, 0, facing], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([Math.abs(x0), 0, Math.abs(x1), 0, Math.abs(x1), 1, Math.abs(x0), 1], 2));
  geometry.setIndex(facing > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
  return geometry;
}

/** A paper leaf as a strip of quads that follows LeafShape (same segments as the HTML strips). */
function leafLightGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const vertices = (SEGMENTS + 1) * 2;
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
  const uv = new Float32Array(vertices * 2);
  const index: number[] = [];
  for (let i = 0; i <= SEGMENTS; i += 1) {
    uv.set([(i / SEGMENTS) * W, 0, (i / SEGMENTS) * W, 1], i * 4);
    if (i < SEGMENTS) {
      const a = i * 2;
      index.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

function writeLeafLight(geometry: THREE.BufferGeometry, shape: LeafShape): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i <= SEGMENTS; i += 1) {
    // Averaged normals at the joints give smooth shading across the flat segments.
    const angle = i === 0 ? shape.angle[0] : i === SEGMENTS ? shape.angle[SEGMENTS - 1] : (shape.angle[i - 1] + shape.angle[i]) / 2;
    const nx = -Math.sin(angle);
    const nz = Math.cos(angle);
    position.setXYZ(i * 2, shape.x[i], -H / 2, shape.z[i]);
    position.setXYZ(i * 2 + 1, shape.x[i], H / 2, shape.z[i]);
    normal.setXYZ(i * 2, nx, 0, nz);
    normal.setXYZ(i * 2 + 1, nx, 0, nz);
  }
  position.needsUpdate = true;
  normal.needsUpdate = true;
}

export class BookScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 60);
  /** Book-local frame (see book-geometry.ts). */
  readonly book = new THREE.Group();
  /** Hinge frame per leaf; leaf 0 is the front cover board. */
  readonly leafFrames: THREE.Group[] = [];
  readonly shapes: LeafShape[] = [];
  readonly heights: StackHeights = { right: BOOK.block, left: 0 };
  readonly faces: VisibleFaces = { left: -1, right: 0, turning: -1 };

  private readonly scene = new THREE.Scene();
  private readonly placement = new THREE.Group();
  private readonly keyLight = new THREE.DirectionalLight('#ffe9cc', 2.5);
  private readonly rightBlock: THREE.Mesh;
  private readonly leftBlock: THREE.Mesh;
  private readonly rightEdge: { value: number };
  private readonly leftEdge: { value: number };
  private readonly spine: THREE.Mesh;
  private readonly coverOuterLight: THREE.Mesh;
  private readonly coverInnerLight: THREE.Mesh;
  private readonly backInnerLight: THREE.Mesh;
  private readonly leafLights: THREE.Mesh[] = [];
  private readonly angles: number[] = [];
  private bend = -1;
  private spineKey = '';
  private readonly worldTarget = new THREE.Vector3();

  constructor(host: HTMLElement, leafCount: number, quality: Quality) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    host.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight('#f6e3c4', '#2b2119', 1.35));
    this.keyLight.shadow.camera.left = -2.8;
    this.keyLight.shadow.camera.right = 2.8;
    this.keyLight.shadow.camera.top = 2.8;
    this.keyLight.shadow.camera.bottom = -2.8;
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 16;
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.normalBias = 0.004;
    this.keyLight.shadow.radius = 4;
    this.scene.add(this.keyLight, this.keyLight.target);
    const rim = new THREE.DirectionalLight('#c98a5c', 1.1);
    rim.position.set(3.2, 1.2, -2.6);
    this.scene.add(rim);

    // A wall behind the book that only shows the book's shadow, so it reads as an
    // object in space without adding a visible backdrop.
    const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(30, 20), new THREE.ShadowMaterial({ color: '#080605', opacity: 0.34 }));
    backdrop.position.z = -1.05;
    backdrop.receiveShadow = true;
    this.scene.add(backdrop);
    this.scene.add(this.createMotes());

    this.scene.add(this.placement);
    this.placement.add(this.book);

    const grain = leatherGrain();
    const leather = new THREE.MeshStandardMaterial({ color: '#5b2f27', roughness: 0.66, bumpMap: grain, bumpScale: 0.6 });
    const boardGeometry = new RoundedBoxGeometry(W + O, H + 2 * O, BT, 2, 0.007);

    const backBoard = new THREE.Mesh(boardGeometry, leather);
    backBoard.position.set((W + O) / 2, 0, -BT / 2);
    backBoard.castShadow = true;
    backBoard.receiveShadow = true;
    this.book.add(backBoard);

    const coverLightMaterial = createPageLightMaterial({ gutter: 0, side: THREE.FrontSide });
    const planeLightMaterial = createPageLightMaterial({ gutter: 0.2, side: THREE.FrontSide });
    const leafLightMaterial = createPageLightMaterial({ gutter: 0.2, side: THREE.DoubleSide });

    // Leaf 0: the front cover board, with the outside of the cover and the endpaper as faces.
    const cover = new THREE.Group();
    const frontBoard = new THREE.Mesh(boardGeometry, leather);
    frontBoard.position.set((W + O) / 2, 0, BT / 2);
    frontBoard.castShadow = true;
    frontBoard.receiveShadow = true;
    this.coverOuterLight = new THREE.Mesh(facePlane(0, W + O, -H / 2 - O, H / 2 + O, BT + GAP, 1), coverLightMaterial);
    this.coverInnerLight = new THREE.Mesh(facePlane(0, W, -H / 2, H / 2, -GAP, -1), planeLightMaterial);
    cover.add(frontBoard, this.coverOuterLight, this.coverInnerLight);
    this.book.add(cover);
    this.leafFrames.push(cover);
    this.shapes.push(createLeafShape(1));
    this.angles.push(-1);

    for (let leaf = 1; leaf < leafCount; leaf += 1) {
      const frame = new THREE.Group();
      const light = new THREE.Mesh(leafLightGeometry(), leafLightMaterial);
      light.frustumCulled = false;
      frame.add(light);
      this.book.add(frame);
      this.leafFrames.push(frame);
      this.leafLights.push(light);
      this.shapes.push(createLeafShape(SEGMENTS));
      this.angles.push(-1);
    }

    this.backInnerLight = new THREE.Mesh(facePlane(0, W, -H / 2, H / 2, GAP, 1), planeLightMaterial);
    this.backInnerLight.receiveShadow = true;
    this.book.add(this.backInnerLight);

    const blockGeometry = new THREE.BoxGeometry(1, 1, 1);
    blockGeometry.translate(0.5, 0, 0.5);
    const right = pageEdgeMaterial();
    const left = pageEdgeMaterial();
    this.rightEdge = right.height;
    this.leftEdge = left.height;
    this.rightBlock = new THREE.Mesh(blockGeometry, right.material);
    this.leftBlock = new THREE.Mesh(blockGeometry, left.material);
    this.leftBlock.scale.x = -1;
    for (const block of [this.rightBlock, this.leftBlock]) {
      block.scale.set(block.scale.x * W, H, BOOK.block);
      block.castShadow = true;
      block.receiveShadow = true;
      this.book.add(block);
    }

    const label = spineLabel();
    this.spine = new THREE.Mesh(this.createSpineGeometry(), new THREE.MeshStandardMaterial({ map: label, roughness: 0.6, bumpMap: grain, bumpScale: 0.6, side: THREE.DoubleSide }));
    this.spine.castShadow = true;
    this.spine.frustumCulled = false;
    this.book.add(this.spine);

    // Bookmark ribbon hanging from the foot of the spine.
    const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(0.045, 0.26), new THREE.MeshStandardMaterial({ color: '#9b4334', roughness: 0.8, side: THREE.DoubleSide }));
    ribbon.position.set(0.09, -H / 2 - 0.1, BOOK.block * 0.45);
    ribbon.rotation.set(0.25, 0, -0.14);
    ribbon.castShadow = true;
    this.book.add(ribbon);

    this.setQuality(quality);
  }

  setQuality(quality: Quality): void {
    this.renderer.setPixelRatio(quality.pixelRatio);
    if (this.keyLight.shadow.mapSize.x !== quality.shadowSize) {
      this.keyLight.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    if (this.renderer.shadowMap.enabled === quality.shadows) return;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.keyLight.castShadow = quality.shadows;
    // Materials compile differently with and without shadows.
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) (object.material as THREE.Material).needsUpdate = true;
    });
  }

  /** Redraws the spine title once the web fonts have loaded. */
  refreshLabels(): void {
    const material = this.spine.material as THREE.MeshStandardMaterial;
    material.map?.dispose();
    material.map = spineLabel();
    material.needsUpdate = true;
  }

  setSize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  /** Applies a book state and camera pose, and updates world matrices for the HTML projector. */
  update(state: BookState, pose: Pose, focus: number, pageMode: boolean, bend: number): void {
    const { leaves } = state;
    const leafCount = leaves.length;
    stackHeights(leaves, this.heights);
    visibleFaces(leaves, this.faces);
    const bendChanged = bend !== this.bend;
    this.bend = bend;

    for (let leaf = 0; leaf < leafCount; leaf += 1) {
      const progress = leaves[leaf];
      const theta = turnAngle(progress);
      const frame = this.leafFrames[leaf];
      // Paper hinges sit a hair above the stack so their light mesh never z-fights the block;
      // the HTML faces add the same gap again on either side of the sheet.
      frame.position.z = hingeHeight(leaf, progress, this.heights, leafCount) + (leaf > 0 ? GAP : 0);
      if (theta === this.angles[leaf] && !bendChanged) continue;
      this.angles[leaf] = theta;
      if (leaf === 0) {
        frame.rotation.y = -theta;
      } else {
        leafShape(theta, bend, W, this.shapes[leaf]);
        writeLeafLight(this.leafLights[leaf - 1].geometry, this.shapes[leaf]);
      }
    }

    // Page block: each stack is a box whose top is the surface its top page lies on.
    this.rightBlock.visible = this.heights.right > 1e-4;
    this.leftBlock.visible = this.heights.left > 1e-4;
    this.rightBlock.scale.z = Math.max(this.heights.right, 1e-4);
    this.leftBlock.scale.z = Math.max(this.heights.left, 1e-4);
    this.rightEdge.value = this.heights.right;
    this.leftEdge.value = this.heights.left;

    // Light meshes exist only where an HTML face is visible.
    const { left, right, turning } = this.faces;
    this.coverOuterLight.visible = right === 0 || turning === 0;
    this.coverInnerLight.visible = left === 1 || turning === 0;
    this.coverOuterLight.receiveShadow = this.coverInnerLight.receiveShadow = turning !== 0;
    this.leafLights.forEach((light, index) => {
      const leaf = index + 1;
      const isTurning = turning === leaf;
      light.visible = isTurning || right === 2 * leaf || left === 2 * leaf + 1;
      light.castShadow = isTurning;
      light.receiveShadow = !isTurning;
    });
    this.backInnerLight.visible = right === 2 * leafCount;

    const coverAngle = this.angles[0];
    const coverHinge = this.leafFrames[0].position.z;
    const spineKey = `${coverAngle.toFixed(4)}:${coverHinge.toFixed(4)}`;
    if (spineKey !== this.spineKey) {
      this.spineKey = spineKey;
      this.writeSpine(coverAngle, coverHinge);
    }

    // Placement: the pose positions the book's centre, which moves from the middle
    // of the closed book to the spine as the cover opens.
    const pivot = pivotFor(smoothstep(0, 1, leaves[0]), this.heights);
    this.book.position.set(-pivot.x, 0, -pivot.z);
    this.placement.position.set(pose.px, pose.py, pose.pz);
    this.placement.rotation.set(pose.rx, pose.ry, pose.rz);
    // In page mode the camera slides to the page in focus (-1 left, 1 right).
    const focusX = pageMode ? (focus * W) / 2 - pivot.x : 0;
    this.camera.position.set(pose.tx + focusX, pose.ty, pose.d);

    this.scene.updateMatrixWorld();
    this.camera.updateMatrixWorld();

    this.worldTarget.setFromMatrixPosition(this.placement.matrixWorld);
    this.keyLight.target.position.copy(this.worldTarget);
    this.keyLight.position.copy(this.worldTarget).add(KEY_OFFSET);
    this.keyLight.updateMatrixWorld();
    this.keyLight.target.updateMatrixWorld();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
          material.dispose();
        }
      }
    });
    this.keyLight.shadow.map?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private createMotes(): THREE.Points {
    // Sparse dust behind the book: static, but gives depth when the camera moves.
    const count = 90;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 9;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 5;
      positions[i * 3 + 2] = -0.5 - Math.random() * 2;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#d8b987', size: 0.018, transparent: true, opacity: 0.4, depthWrite: false }));
  }

  private createSpineGeometry(): THREE.BufferGeometry {
    // Outer surface plus a cap at the head and tail of the spine.
    const columns = SPINE_SEGMENTS + 1;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(columns * 6 * 3), 3));
    const uv = new Float32Array(columns * 6 * 2);
    const index: number[] = [];
    for (let i = 0; i < columns; i += 1) {
      const u = i / SPINE_SEGMENTS;
      // Rows: outer surface (bottom, top), head cap (outer, inner), tail cap (outer, inner).
      uv.set([u, 0, u, 1, u, 1, u, 1, u, 0, u, 0], i * 12);
      if (i < SPINE_SEGMENTS) {
        for (const row of [0, 2, 4]) {
          const a = i * 6 + row;
          const b = (i + 1) * 6 + row;
          index.push(a, b, b + 1, a, b + 1, a + 1);
        }
      }
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(index);
    return geometry;
  }

  /** Bends the spine between the back board and the front board's hinge edge. */
  private writeSpine(coverAngle: number, coverHinge: number): void {
    const geometry = this.spine.geometry;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const half = H / 2 + O;
    // Outer hinge edges of both boards and the directions the spine leaves them in.
    const bx = 0;
    const bz = -BT;
    const fx = -BT * Math.sin(coverAngle);
    const fz = coverHinge + BT * Math.cos(coverAngle);
    const reach = Math.hypot(fx - bx, fz - bz) * 0.62;
    const c1x = bx - reach;
    const c1z = bz;
    const c2x = fx - Math.cos(coverAngle) * reach;
    const c2z = fz - Math.sin(coverAngle) * reach;
    this.spine.visible = reach > 1e-3;
    let px = bx;
    let pz = bz;
    for (let i = 0; i <= SPINE_SEGMENTS; i += 1) {
      const t = i / SPINE_SEGMENTS;
      const s = 1 - t;
      const x = s * s * s * bx + 3 * s * s * t * c1x + 3 * s * t * t * c2x + t * t * t * fx;
      const z = s * s * s * bz + 3 * s * s * t * c1z + 3 * s * t * t * c2z + t * t * t * fz;
      // Inward offset by the board thickness, perpendicular to the curve.
      const dx = i === 0 ? c1x - bx : x - px;
      const dz = i === 0 ? c1z - bz : z - pz;
      const length = Math.hypot(dx, dz) || 1;
      const ix = x + (dz / length) * BT;
      const iz = z - (dx / length) * BT;
      const base = i * 6;
      position.setXYZ(base, x, -half, z);
      position.setXYZ(base + 1, x, half, z);
      position.setXYZ(base + 2, x, half, z);
      position.setXYZ(base + 3, ix, half, iz);
      position.setXYZ(base + 4, x, -half, z);
      position.setXYZ(base + 5, ix, -half, iz);
      px = x;
      pz = z;
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
  }
}
