// styles.js — Catálogo de estilos visuales para las ilustraciones IA in-video.
// ESPEJO de mackree-styles/style-catalog.json (skill). Si cambian los prompt_base
// en el skill, actualizar acá también. El cliente del SaaS elige el estilo en el
// dashboard (manifest.visualStyle); el worker lo usa para generar las imágenes IA
// que se insertan en el video, en AMBOS flujos (edit + create con voz clonada).
//
// Decisión Javier 2026-05-20: el estilo visual es PREFERENCIA del cliente (dropdown),
// default 'doodle' (el de Santiago). Reemplaza el viejo "cinematic photorealistic".

export const DEFAULT_STYLE = 'doodle'

export const STYLES = {
  doodle: {
    label: 'Doodle Sketch (Santiago)',
    ideal_for: 'Universal — comodín cualquier industria',
    prompt_base:
      'hand-drawn doodle illustration, black marker line art on clean white background, simple stick figures, minimal neutral colors with one accent color (limon green or yellow), educational explainer style, casual friendly, horizontal composition',
  },
  whiteboard: {
    label: 'Whiteboard Marker',
    ideal_for: 'Cursos, coaching, B2B, consultoría',
    prompt_base:
      'whiteboard sketch illustration, black and blue dry-erase marker drawing on a clean white whiteboard, hand-drawn diagrams arrows and labels, flowchart style, educational professional, horizontal composition',
  },
  flat: {
    label: 'Flat Modern (Notion / unDraw)',
    ideal_for: 'SaaS, startups, apps, fintech',
    prompt_base:
      'flat vector illustration, modern minimal Notion / unDraw style, geometric stylized people, solid corporate colors (deep blue, mint green, soft purple) with subtle gradients, no shadows, clean startup landing page aesthetic, horizontal layout',
  },
  isometric: {
    label: 'Isometric 3D',
    ideal_for: 'Logística, ingeniería, e-commerce con proceso',
    prompt_base:
      'isometric 3D illustration, 30-degree axonometric view, flat saturated colors, stylized buildings vehicles and people, technical infographic clean style, light gray or white background, horizontal layout',
  },
  claymation: {
    label: 'Claymation 3D (Playdough)',
    ideal_for: 'Retail, lifestyle, food, productos de consumo',
    prompt_base:
      '3D claymation playdough illustration, handcrafted plasticine figures with visible clay texture, pastel saturated colors (mint, coral, lavender), soft directional shadows, tactile 3D studio render, white studio background, trendy 2025 style, horizontal',
  },
  watercolor: {
    label: 'Watercolor Soft',
    ideal_for: 'Wellness, beauty, gastronomía artesanal, marca personal',
    prompt_base:
      'soft watercolor illustration, hand-painted with delicate brush strokes and bleeding pigments, muted earthy tones (terracotta, sage, ochre), generous white breathing space, artisan editorial aesthetic, horizontal composition',
  },
}

/** Devuelve el prompt_base del estilo (o el default si la key no existe). */
export function stylePromptBase(key) {
  return (STYLES[key] || STYLES[DEFAULT_STYLE]).prompt_base
}

/** Normaliza una key de estilo a una válida del catálogo. */
export function normalizeStyle(key) {
  return STYLES[key] ? key : DEFAULT_STYLE
}
