import { createRenderer, nextTick } from 'vue';

export type HostNode = {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: HostNode[];
  parent: HostNode | null;
  tagName: string;
  style: Record<string, any>;
  value: string;
  checked: boolean;
  selected: boolean;
  addEventListener: (name: string, listener: (...args: any[]) => void) => void;
  removeEventListener: (name: string, listener: (...args: any[]) => void) => void;
  dispatchEvent: (event: { type: string }) => boolean;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  removeAttribute: (name: string) => void;
  options: HostNode[];
};

export function hostNode(tag: string, text = ''): HostNode {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const node = {
    tag, text, props: {} as Record<string, any>, children: [] as HostNode[], parent: null as HostNode | null,
    tagName: tag.toUpperCase(), style: {} as Record<string, any>, value: '', checked: false, selected: false,
    addEventListener(name: string, listener: (...args: any[]) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    removeEventListener(name: string, listener: (...args: any[]) => void) { listeners.get(name)?.delete(listener); },
    dispatchEvent(event: { type: string }) { for (const listener of listeners.get(event.type) || []) listener(event); return true; },
    setAttribute(name: string, value: string) { node.props[name] = String(value); },
    getAttribute(name: string) { return node.props[name] == null ? null : String(node.props[name]); },
    removeAttribute(name: string) { delete node.props[name]; },
    get options() { return descendants(node).filter(child => child.tag === 'option'); },
  };
  return node;
}

export function descendants(node: HostNode): HostNode[] { return node.children.flatMap(child => [child, ...descendants(child)]); }
function insert(child: HostNode, parent: HostNode, anchor: HostNode | null = null) {
  if (child.parent) {
    const oldIndex = child.parent.children.indexOf(child);
    if (oldIndex >= 0) child.parent.children.splice(oldIndex, 1);
  }
  const at = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(at < 0 ? parent.children.length : at, 0, child);
  child.parent = parent;
}
export const renderer = createRenderer<HostNode, HostNode>({
  createElement: tag => hostNode(tag),
  createText: text => hostNode('#text', text),
  createComment: text => hostNode('#comment', text),
  setText: (node, text) => { node.text = text; },
  setElementText: (node, text) => { node.text = text; node.children = []; },
  patchProp: (node, key, _previous, next) => {
    node.props[key] = next;
    if (key === 'checked') node.checked = next === '' || Boolean(next);
  },
  insert,
  remove: node => { if (node.parent) { node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; } },
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  insertStaticContent: (content, parent, anchor) => { const node = hostNode('#static', content); insert(node, parent, anchor); return [node, node]; },
});

export function visibleText(node: HostNode): string {
  return [node.text, ...node.children.map(visibleText)].join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
export function button(root: HostNode, label: string): HostNode {
  const found = descendants(root).find(node => node.tag === 'button' &&
    (visibleText(node).includes(label) || node.props['aria-label'] === label));
  if (!found) throw new Error(`未找到按钮：${label}`);
  return found;
}
export async function click(node: HostNode) {
  const handler = node.props.onClick;
  if (typeof handler !== 'function') throw new Error(`按钮没有 onClick：${visibleText(node)}`);
  await handler({ target: node, currentTarget: node });
  await settle();
}
export async function settle() { await Promise.resolve(); await Promise.resolve(); await nextTick(); }

