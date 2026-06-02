// styles.js — Catálogo de estilos visuales para las ilustraciones IA in-video.
// Basado en mackree-styles/style-catalog.json (skill). El cliente del SaaS elige
// el estilo en el dashboard (manifest.visualStyle); el worker lo usa para generar
// las imágenes IA que se insertan en el video, en AMBOS flujos (edit + create).
//
// Decisión Javier 2026-05-20: el estilo visual es PREFERENCIA del cliente (dropdown),
// default 'doodle' (el de Santiago). Reemplaza el viejo "cinematic photorealistic".
//
// ⛔ ORIENTACIÓN (fix 2026-05-24): los prompt_base NO fijan orientación.
// Antes terminaban en "horizontal composition", lo que contradecía el aspect_ratio
// vertical 9:16 del video → nano-banana acostaba el contenido 90° (texto de lado).
// La orientación correcta (vertical/cuadrada/horizontal) la inyecta kie-image.js
// según el aspect ratio del video de destino. Por eso este catálogo diverge a
// propósito del skill (que genera muestras 16:9 para los thumbnails del dashboard).

export const DEFAULT_STYLE = 'doodle'

export const STYLES = {
  doodle: {
    label: 'Doodle Sketch (Santiago)',
    ideal_for: 'Universal — comodín cualquier industria',
    prompt_base:
      'hand-drawn doodle illustration, black marker line art on clean white background, ONE single clear subject, minimal elements, generous negative space, simple stick figures, minimal neutral colors with one accent color (limon green or yellow), casual friendly, NOT a dense infographic, few or no text labels',
  },
  whiteboard: {
    label: 'Whiteboard Marker',
    ideal_for: 'Cursos, coaching, B2B, consultoría',
    prompt_base:
      'whiteboard sketch illustration, black and blue dry-erase marker drawing on a clean white whiteboard, hand-drawn diagrams arrows and labels, flowchart style, educational professional',
  },
  flat: {
    label: 'Flat Modern (Notion / unDraw)',
    ideal_for: 'SaaS, startups, apps, fintech',
    prompt_base:
      'flat vector illustration, modern minimal Notion / unDraw style, geometric stylized people, solid corporate colors (deep blue, mint green, soft purple) with subtle gradients, no shadows, clean startup landing page aesthetic',
  },
  isometric: {
    label: 'Isometric 3D',
    ideal_for: 'Logística, ingeniería, e-commerce con proceso',
    prompt_base:
      'isometric 3D illustration, 30-degree axonometric view, flat saturated colors, stylized buildings vehicles and people, technical infographic clean style, light gray or white background',
  },
  claymation: {
    label: 'Claymation 3D (Playdough)',
    ideal_for: 'Retail, lifestyle, food, productos de consumo',
    prompt_base:
      '3D claymation playdough illustration, handcrafted plasticine figures with visible clay texture, pastel saturated colors (mint, coral, lavender), soft directional shadows, tactile 3D studio render, white studio background, trendy 2025 style',
  },
  watercolor: {
    label: 'Watercolor Soft',
    ideal_for: 'Wellness, beauty, gastronomía artesanal, marca personal',
    prompt_base:
      'soft watercolor illustration, hand-painted with delicate brush strokes and bleeding pigments, muted earthy tones (terracotta, sage, ochre), generous white breathing space, artisan editorial aesthetic',
  },
  comic: {
    label: 'Cómic / Pop-art',
    ideal_for: 'Retail, gaming, eventos, gastronomía casual',
    prompt_base:
      'bold comic book / pop-art illustration, thick black ink outlines, Ben-Day halftone dot shading, vibrant saturated primary colors (red, yellow, blue), dynamic energetic retro comic aesthetic',
  },
  lineart: {
    label: 'Línea minimalista',
    ideal_for: 'Belleza, moda, marca personal, arquitectura',
    prompt_base:
      'minimalist single continuous line illustration, elegant thin black line art on clean white background, one subtle accent color, abundant negative space, refined sophisticated editorial aesthetic',
  },
  render3d: {
    label: '3D render (Pixar)',
    ideal_for: 'Mascotas de marca, producto, apps, kids',
    prompt_base:
      'polished 3D render illustration, Pixar / Blender cartoon style, soft studio lighting with gentle shadows, rounded glossy stylized characters and objects, vibrant friendly colors, clean light background, premium look',
  },
  neon: {
    label: 'Neón / Cyberpunk',
    ideal_for: 'Tecnología, gaming, nightlife, cripto',
    prompt_base:
      'glowing neon illustration on a dark background, vibrant luminous outlines (cyan, magenta, electric blue), futuristic cyberpunk tech aesthetic, subtle dark grid, high contrast sleek modern',
  },
  cinematic: {
    label: 'Cinematic fotorrealista',
    ideal_for: 'Automotriz, inmobiliaria, lujo, restaurantes gourmet',
    prompt_base:
      'cinematic photorealistic illustration, shallow depth of field bokeh, dramatic golden hour natural lighting, premium commercial film look, rich realistic detail, color-graded warm tones',
  },
  papercut: {
    label: 'Papel recortado',
    ideal_for: 'Marcas eco, kids, educación, editorial creativo',
    prompt_base:
      'layered paper cut-out collage illustration, stacked colored paper shapes with soft drop shadows, handcrafted papercraft depth, tactile artisan look, pastel and muted earth tones',
  },
  sticker: {
    label: 'Sticker / Kawaii',
    ideal_for: 'Comida, lifestyle, apps sociales, Gen-Z',
    prompt_base:
      'cute kawaii die-cut sticker illustration, bold clean glossy outlines, bright pastel pop colors, playful friendly Gen-Z aesthetic, white border, cheerful simple characters',
  },
  // 'auto' = "Estilo Chixy" (el estilo de la casa): estilo INSIGNIA de Chixy desde WS3 (2026-06-01).
  // Antes era un placeholder que llm-moments.js interceptaba → doodle. Ahora es la línea gráfica
  // PROPIA de Chixy, derivada FIEL del comercial que Santiago generó para respondele.com
  // (video M1UQzYaQl4Y, 5:56-7:10): line-art editorial elegante, fondo papel crema cálido con
  // glow durazno, acento verde sage, premium minimalista. Look aprobado por Javier 2026-06-01.
  // Se conserva la KEY 'auto' (no se renombra) para no migrar video_jobs.visual_style existentes.
  auto: {
    label: 'Estilo Chixy',
    ideal_for: 'El estilo de la casa — servicios premium, salud, marcas que cuentan una historia',
    prompt_base:
      'elegant minimalist editorial illustration, delicate fine line-art with thin clean strokes, warm cream / ivory paper background with soft peach and pink glow, muted sage green accent color, refined premium clinical aesthetic, generous negative space, soft subtle shadows, calm sophisticated trustworthy mood, ONE clear simple subject, NOT a doodle, NOT photorealistic',
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
