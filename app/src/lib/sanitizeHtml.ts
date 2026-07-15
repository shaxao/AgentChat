const BLOCKED_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
])

const URL_ATTRS = new Set([
  'href',
  'src',
  'xlink:href',
  'formaction',
  'action',
  'poster',
])

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isUnsafeUrl(value: string) {
  const normalized = value.replace(/[\u0000-\u001F\u007F\s]+/g, '').toLowerCase()
  return normalized.startsWith('javascript:')
    || normalized.startsWith('vbscript:')
    || normalized.startsWith('data:text/html')
    || normalized.startsWith('data:image/svg+xml')
}

export function sanitizeHtml(html: string) {
  if (!html) return ''
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return escapeHtml(html)
  }

  const doc = new DOMParser().parseFromString(`<template>${html}</template>`, 'text/html')
  const template = doc.querySelector('template')
  if (!template) return ''

  const walker = doc.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT)
  const nodes: Element[] = []
  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Element)
  }

  for (const node of nodes) {
    const tag = node.tagName.toLowerCase()
    if (BLOCKED_TAGS.has(tag)) {
      node.remove()
      continue
    }

    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value || ''
      if (name.startsWith('on')) {
        node.removeAttribute(attr.name)
        continue
      }
      if (URL_ATTRS.has(name) && isUnsafeUrl(value)) {
        node.removeAttribute(attr.name)
        continue
      }
      if (name === 'style' && /expression\s*\(|javascript:|vbscript:|data:text\/html/i.test(value)) {
        node.removeAttribute(attr.name)
      }
    }

    if (tag === 'a' && node.getAttribute('target') === '_blank') {
      node.setAttribute('rel', 'noopener noreferrer')
    }
  }

  return template.innerHTML
}
