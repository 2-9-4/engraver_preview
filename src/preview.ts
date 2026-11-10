import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Project } from './types';
import type { Surface } from './core/simulate';

export class Preview3D {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 4000);
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private model: THREE.Group | null = null;
  private resizeObserver: ResizeObserver;
  private frame = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.6;
    this.host.append(this.renderer.domElement);
    this.scene.background = new THREE.Color('#171e25');
    this.scene.add(new THREE.HemisphereLight(0xe7f0ff, 0x44301f, 2.0));
    const key = new THREE.DirectionalLight(0xffe7c1, 3.2);
    key.position.set(-90, 150, 70);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9cc7e2, 1.4);
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

  setSurface(project: Project, surface: Surface): void {
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach(mat => mat.dispose());
        }
      });
    }
    this.model = new THREE.Group();
    const w = surface.width, h = surface.height, stride = w + 1;
    const verts = new Float32Array(stride * (h + 1) * 3);
    const colors = new Float32Array(verts.length);
    const topIndices: number[] = [];
    for (let y = 0; y <= h; y++) for (let x = 0; x <= w; x++) {
      const idx = y * stride + x;
      const depth = surface.values[idx]!;
      verts[3 * idx] = project.width * (x / w - 0.5);
      verts[3 * idx + 1] = depth;
      verts[3 * idx + 2] = project.height * (0.5 - y / h);
      const grain = Math.sin(y * 0.21 + Math.sin(x * 0.045) * 1.4) * 0.025;
      const cut = Math.max(0, Math.min(1, -depth / 3));
      const tint = 1 + grain - cut * 0.15;
      colors[3 * idx] = 0.76 * tint;
      colors[3 * idx + 1] = 0.51 * tint;
      colors[3 * idx + 2] = 0.30 * tint;
      if (x < w && y < h) {
        const a = idx, b = idx + 1, c = idx + stride, d = c + 1;
        topIndices.push(a, c, b, b, c, d);
      }
    }
    const top = new THREE.BufferGeometry();
    top.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    top.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    top.setIndex(topIndices);
    top.computeVertexNormals();
    const topMesh = new THREE.Mesh(top, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, side: THREE.DoubleSide }));
    this.model.add(topMesh);

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
      this.model.add(new THREE.Mesh(sideGeo, new THREE.MeshStandardMaterial({ color: '#9a6b40', roughness: 0.95, side: THREE.DoubleSide })));
    }
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(project.width, project.height),
      new THREE.MeshStandardMaterial({ color: '#8e633e', roughness: 1, side: THREE.DoubleSide }),
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = -project.thickness;
    this.model.add(base);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(top, 40), new THREE.LineBasicMaterial({ color: 0x3d2a18, transparent: true, opacity: 0.3 }));
    this.model.add(edge);
    this.scene.add(this.model);
    this.controls.target.set(0, -project.thickness * 0.25, 0);
    this.controls.update();
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
