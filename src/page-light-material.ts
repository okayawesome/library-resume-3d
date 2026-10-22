import * as THREE from 'three';

// The HTML pages sit *behind* the transparent WebGL canvas. Each visible page face
// has a matching mesh drawn with this material: it writes black with an alpha
// equal to how much light the page is missing (and clears whatever WebGL drew
// behind it). The browser composites the canvas over the HTML, so the real DOM
// text shows through, darkened by the scene's lighting, curl and shadows, and
// hidden by any book geometry that is genuinely in front of it.

const vertexShader = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
varying vec3 vNormalView;
varying float vFromSpine;

void main() {
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  vNormalView = normalize(transformedNormal);
  // uv.x carries the distance from the spine in world units.
  vFromSpine = uv.x;
}
`;

const fragmentShader = /* glsl */ `
uniform float uAmbient;
uniform float uDiffuse;
uniform float uShadow;
uniform float uGutter;
uniform float uMaxDark;
varying vec3 vNormalView;
varying float vFromSpine;

#include <common>
#include <packing>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

void main() {
  vec3 normal = normalize(vNormalView) * (gl_FrontFacing ? 1.0 : -1.0);
  float facing = 0.0;
  #if NUM_DIR_LIGHTS > 0
    facing = max(dot(normal, directionalLights[0].direction), 0.0);
  #endif
  float light = uAmbient + uDiffuse * facing * mix(1.0 - uShadow, 1.0, getShadowMask());
  // Paper curves down into the binding, so the gutter catches less light.
  light *= 1.0 - uGutter * exp(-vFromSpine * 18.0);
  gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(1.0 - light, 0.0, uMaxDark));
}
`;

export interface PageLightOptions {
  /** Darkening at the binding (0 for faces that are not near a spine, e.g. the outside cover). */
  gutter: number;
  side: THREE.Side;
}

export function createPageLightMaterial({ gutter, side }: PageLightOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      {
        // Calibrated so a page facing the reader under the key light is untouched (light ≈ 1).
        uAmbient: { value: 0.6 },
        uDiffuse: { value: 0.62 },
        uShadow: { value: 0.75 },
        uGutter: { value: gutter },
        uMaxDark: { value: 0.62 }
      }
    ]),
    vertexShader,
    fragmentShader,
    lights: true,
    side,
    blending: THREE.NoBlending,
    transparent: false,
    toneMapped: false
  });
}
