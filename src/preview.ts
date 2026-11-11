import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Artwork, CompiledOperation, Project } from './types';
import { makeVectorMasks } from './svgMasks';
import { makeCurvedPreview } from './curvedPreview';
import { flatVectorGeometry } from './core/vectorGeometry';
import { createStockMaterial, type StockMaterial } from './materials';
import { defaultPlywoodSettings, type PlywoodSettings } from './plywood';
import type { Surface } from './core/simulate';

export class Preview3D {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 4000);
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private model: THREE.Group | null = null;
  private resizeObserver: ResizeObserver;
  private frame = 0;
  private frameCounter = 0;
  private curvedState: { artwork: Artwork; project: Project; compiled: CompiledOperation; stock: StockMaterial; plywood: PlywoodSettings; density: number; group: THREE.Group } | null = null;
  private vectorMask: {
    project: Project;
    artwork: Artwork;
    compiled: CompiledOperation;
    top: THREE.MeshStandardMaterial;
    floor: THREE.MeshStandardMaterial;
    resolution: number;
  } | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.host.append(this.renderer.domElement);
    this.scene.background = new THREE.Color('#171e25');
    this.scene.add(new THREE.HemisphereLight(0xf5f3ed, 0x514337, 1.15));
    const key = new THREE.DirectionalLight(0xfff5e8, 2.0);
    key.position.set(-90, 150, 70);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xb7c6d0, 0.6);
    rim.position.set(70, 55, -90);
    this.scene.add(rim);
    const grid = new THREE.GridHelper(400, 20, 0x35424b, 0x2b3740);
    grid.position.y = -13;
    this.scene.add(grid);
    this.camera.position.set(110, 135, 155);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 15;
    this.controls.maxDistance = 900;
    this.controls.target.set(0, -2, 0);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      this.controls.update();
      if (++this.frameCounter % 35 === 0) { this.refineVectorMasks(); this.refineCurvedPreview(); }
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setSurface(project: Project, surface: Surface, compiled: CompiledOperation[] = [], stock: StockMaterial = 'mdf', artwork: Artwork | null = null, plywood: PlywoodSettings = defaultPlywoodSettings): void {
    this.vectorMask = null;
    this.curvedState = null;
    this.host.dataset.previewMode = 'heightfield';
    this.host.dataset.stockMaterial = stock;
    this.host.dataset.previewTopology = 'legacy';
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach(mat => { if (mat instanceof THREE.MeshStandardMaterial) mat.alphaMap?.dispose(); mat.dispose(); });
        }
      });
    }
    this.model = new THREE.Group();
    const material = createStockMaterial(stock, false, plywood);
    const sideMaterial = createStockMaterial(stock, true, plywood);
    // SVG flat-endmill engravings are exact cutter-swept polygons with explicit
    // vertical walls, not a sampled heightfield. The cutter circumference alone
    // is tessellated, with <= 0.06 mm nominal chord spacing.
    const curved = artwork?.isSVG && compiled.length === 1 && compiled[0]!.operation.mode === 'vector' &&
      (compiled[0]!.operation.tool === 'vbit' || compiled[0]!.operation.tool === 'ball');
    if (curved && artwork) {
      const request = this.projectedPixelsPerMm();
      const result = makeCurvedPreview(project, artwork, compiled[0]!, stock, request, plywood);
      this.model.add(result.group);
      this.curvedState = { artwork, project: { ...project }, compiled: compiled[0]!, stock,
        plywood: { ...plywood, layerThicknesses: [...plywood.layerThicknesses] },
        density: result.density, group: result.group };
      this.host.dataset.previewMode = 'native-svg-curved';
      this.host.dataset.previewTopology = 'single-indexed-stock';
      material.dispose();
    }
    const exact = !curved && compiled.length === 1 && compiled[0]!.operation.mode === 'vector' && compiled[0]!.operation.tool === 'flat'
      ? flatVectorGeometry(project, compiled[0]!) : null;
    if (exact) {
      // Cutter-swept polygon meshes are still useful for 3D side walls, but
      // their triangulated silhouettes must NEVER define the visible top/floor.
      // Render those faces using the browser's native SVG curves as a vector
      // cut mask; this avoids the polygon clipping and G1 discretization that
      // previously made edges look faceted, even for mathematically smooth SVGs.
      if (artwork?.isSVG) {
        const mmPerScreenPixel = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) *
          this.camera.position.distanceTo(this.controls.target) /
          Math.max(1, this.host.clientHeight);
        const masks = makeVectorMasks(artwork, project, compiled[0]!, Math.max(8, 2 / mmPerScreenPixel));
        const topMaterial = createStockMaterial(stock, false, plywood);
        const floorMaterial = createStockMaterial(stock, false, plywood);
        for (const [mat, texture] of [[topMaterial, masks.top], [floorMaterial, masks.floor]] as const) {
          mat.alphaMap = texture;
          mat.alphaTest = 0.01;
          mat.alphaToCoverage = true;
          mat.depthWrite = true;
          mat.side = THREE.DoubleSide;
          mat.needsUpdate = true;
        }
        const surfacePlane = () => {
          const mesh = new THREE.Mesh(new THREE.PlaneGeometry(project.width, project.height), topMaterial);
          mesh.rotation.x = -Math.PI / 2;
          return mesh;
        };
        this.model.add(surfacePlane());
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(project.width, project.height), floorMaterial);
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = -exact.depth;
        this.model.add(floor);
        this.vectorMask = { project: { ...project }, artwork, compiled: compiled[0]!,
          top: topMaterial, floor: floorMaterial, resolution: masks.resolution };
        this.host.dataset.previewMode = 'native-svg-mask';
        exact.top.dispose();
        exact.floor.dispose();
        material.dispose();
      } else {
        for (const geometry of [exact.top, exact.floor]) this.model.add(new THREE.Mesh(geometry, material));
      }
      this.model.add(new THREE.Mesh(exact.walls, sideMaterial));
    }
    if (!curved) {
    const w = surface.width, h = surface.height, stride = w + 1;
    const verts = new Float32Array(stride * (h + 1) * 3);

    const topIndices: number[] = [];
    for (let y = 0; y <= h; y++) for (let x = 0; x <= w; x++) {
      const idx = y * stride + x;
      const depth = surface.values[idx]!;
      verts[3 * idx] = project.width * (x / w - 0.5);
      verts[3 * idx + 1] = depth;
      verts[3 * idx + 2] = project.height * (0.5 - y / h);

      if (x < w && y < h) {
        const a = idx, b = idx + 1, c = idx + stride, d = c + 1;
        topIndices.push(a, b, c, b, d, c);
      }
    }
    const top = new THREE.BufferGeometry();
    top.setAttribute('position', new THREE.BufferAttribute(verts, 3));

    top.setIndex(topIndices);
    top.computeVertexNormals();
    if (!exact && !curved) {
      // Flat shading prevents normal interpolation from disguising heightfield
      // limitations. Non-flat tools and raster inputs still use this solver.
      const topMesh = new THREE.Mesh(top, material);
      this.model.add(topMesh);
    } else {
      top.dispose();
    }

    const sideVerts: number[] = [];
    const sideIndices: number[] = [];
    const addSide = (ix: number) => {
      const base = sideVerts.length / 3;
      const x = verts[3 * ix]!, y = verts[3 * ix + 1]!, z = verts[3 * ix + 2]!;
      sideVerts.push(x, y, z, x, -project.thickness, z);
      if (base >= 2) sideIndices.push(base - 2, base - 1, base, base, base - 1, base + 1);
    };
    const edges: number[][] = [];
    edges.push(Array.from({ length: w + 1 }, (_, i) => i));
    edges.push(Array.from({ length: h + 1 }, (_, i) => i * stride + w));
    edges.push(Array.from({ length: w + 1 }, (_, i) => h * stride + w - i));
    edges.push(Array.from({ length: h + 1 }, (_, i) => (h - i) * stride));
    for (const edge of edges) {
      sideVerts.length = 0; sideIndices.length = 0;
      for (const i of edge) addSide(i);
      const sideGeo = new THREE.BufferGeometry();
      sideGeo.setAttribute('position', new THREE.Float32BufferAttribute(sideVerts, 3));
      sideGeo.setIndex(sideIndices);
      sideGeo.computeVertexNormals();
      this.model.add(new THREE.Mesh(sideGeo, sideMaterial));
    }
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(project.width, project.height),
      sideMaterial,
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = -project.thickness;
    this.model.add(base);

    } else {
      // V/ball stock already includes its own perimeter and bottom in a
      // SINGLE closed mesh. Never add the old heightfield side walls or base.
      sideMaterial.dispose();
    }

    let meshCount = 0;
    this.model.traverse(obj => { if (obj instanceof THREE.Mesh) meshCount++; });
    this.host.dataset.previewMeshes = String(meshCount);
    this.scene.add(this.model);
    this.controls.target.set(0, -project.thickness * 0.25, 0);
    this.controls.update();
  }

  private projectedPixelsPerMm(): number {
    const distance = Math.max(1, this.camera.position.distanceTo(this.controls.target));
    const mmPerPixel = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) *
      distance / Math.max(1, this.host.clientHeight * this.renderer.getPixelRatio());
    return Math.max(8, 2 / mmPerPixel);
  }

  // The masks are rasterized *only at the display boundary* from the original
  // parametric SVG (not from CAM paths). Regenerate after camera zoom so the
  // temporary display texture does not become a visibly pixelated engraving.
  private refineVectorMasks(): void {
    const state = this.vectorMask;
    if (!state) return;
    const request = this.projectedPixelsPerMm();
    const max = 6144 / Math.max(state.project.width, state.project.height);
    if (request <= state.resolution * 1.4 || state.resolution >= max * 0.99) return;
    const next = makeVectorMasks(state.artwork, state.project, state.compiled, request);
    const oldTop = state.top.alphaMap, oldFloor = state.floor.alphaMap;
    state.top.alphaMap = next.top;
    state.floor.alphaMap = next.floor;
    state.resolution = next.resolution;
    state.top.needsUpdate = true;
    state.floor.needsUpdate = true;
    oldTop?.dispose();
    oldFloor?.dispose();
  }

  private refineCurvedPreview(): void {
    const state = this.curvedState;
    if (!state) return;
    const desired = this.projectedPixelsPerMm();
    const limit = 2560 / Math.max(state.project.width, state.project.height);
    if (desired <= state.density * 1.5 || state.density >= limit * 0.98) return;
    const replacement = makeCurvedPreview(state.project, state.artwork, state.compiled,
      state.stock, desired, state.plywood);
    this.model?.remove(state.group);
    state.group.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (mat instanceof THREE.MeshStandardMaterial) mat.alphaMap?.dispose();
          mat.dispose();
        }
      }
    });
    this.model?.add(replacement.group);
    state.group = replacement.group;
    state.density = replacement.density;
  }

  resetCamera(project: Project): void {
    const extent = Math.max(project.width, project.height);
    this.camera.position.set(extent * 0.7, extent * 0.9, extent * 1.15);
    this.controls.target.set(0, -project.thickness * 0.25, 0);
    this.controls.update();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
