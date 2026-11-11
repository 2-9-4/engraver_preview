import { defaultPlywoodSettings, plywoodShaderLogic, validatePlywoodSettings, type PlywoodSettings } from './plywood';
import * as THREE from 'three';

export type StockMaterial = 'mdf' | 'plywood' | 'painted-plywood' | 'colorcore';

export function createStockMaterial(
  kind: StockMaterial, side = false, plywood: PlywoodSettings = defaultPlywoodSettings,
): THREE.MeshStandardMaterial {
  const isPlywood = kind === 'plywood' || kind === 'painted-plywood';
  if (isPlywood) validatePlywoodSettings(plywood);
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff', roughness: kind === 'colorcore' || kind === 'painted-plywood' ? 0.68 : 0.94,
    metalness: 0, side: THREE.DoubleSide, flatShading: !side,
  });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vStockPosition;'
    ).replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvStockPosition = (modelMatrix * vec4(position, 1.0)).xyz;'
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
      varying vec3 vStockPosition;
      float hashWood(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float grainWood(vec2 p) {
        float warp = sin(p.x * 0.052 + sin(p.y * 0.035) * 2.4) * 2.3;
        float wave = sin(p.y * 0.68 + warp + sin(p.x * 0.13) * 1.6);
        float fine = sin(p.y * 3.6 + warp * 2.7);
        return wave * 0.48 + fine * 0.13 + (hashWood(floor(p * 2.0)) - 0.5) * 0.11;
      }
      `
    );
    const materialLogic = kind === 'mdf' ? `
      float fleck = hashWood(floor(vStockPosition.xz * 8.0 + vStockPosition.y * 3.0));
      float dust = hashWood(floor(vStockPosition.xz * 19.0 - vStockPosition.y * 7.0));
      vec3 pigment = vec3(0.64, 0.46, 0.30);
      pigment *= 0.88 + 0.17 * fleck + 0.055 * dust;
    ` : kind === 'plywood' || kind === 'painted-plywood' ? plywoodShaderLogic(kind, plywood): `
      float finish = smoothstep(-0.16, -0.09, vStockPosition.y);
      float noise = hashWood(floor(vStockPosition.xz * 5.0));
      vec3 core = vec3(0.77, 0.67, 0.49) * (0.96 + 0.07 * noise);
      vec3 face = vec3(0.11, 0.21, 0.26);
      vec3 pigment = mix(core, face, finish);
    `;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
      '#include <color_fragment>\n' + materialLogic + '\ndiffuseColor.rgb *= pigment;');
  };
  // The shader changes when the layup changes. Do not reuse an old compiled
  // program for a different face veneer, ply sequence or painted coating.
  material.customProgramCacheKey = () => [
    kind, side ? 'side' : 'face',
    ...(isPlywood ? [plywood.topVeneerThickness, plywood.layerThicknesses.join(','),
      kind === 'painted-plywood' ? plywood.paintThickness : 0,
      kind === 'painted-plywood' ? plywood.paintColor : ''] : []),
  ].join(':');
  return material;
}
