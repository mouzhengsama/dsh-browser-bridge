export interface BuiltInLink {
  id: string;
  name: string;
  url: string;
  color: string;
  icon?: string;
}

export const BUILT_IN_LINKS: readonly BuiltInLink[] = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com', color: '#10a37f', icon: '✨' },
  { id: 'workbuddy', name: 'WorkBuddy', url: 'https://workbuddy.cn/app', color: '#2ba986', icon: '🤝' },
  { id: 'arena', name: 'Arena', url: 'https://arena.ai/agent', color: '#536fc4', icon: '🛰' },
  { id: 'trae', name: 'Trae', url: 'https://work.trae.cn', color: '#477ec3', icon: '🛠' },
  { id: 'qwen', name: 'Qwen', url: 'https://qwenwork.cn/app/chat', color: '#725eb7', icon: '🪶' },
  { id: 'manus', name: 'Manus', url: 'https://manus.im/app', color: '#555b64', icon: '📜' },
  { id: 'shunova', name: 'Shunova', url: 'https://shunova.cc', color: '#b36d38', icon: '🌅' },
  { id: 'doubao', name: '豆包', url: 'https://doubao.com/chat', color: '#3a91df', icon: '🫘' },
  { id: 'kimi', name: 'Kimi', url: 'https://kimi.moonshot.cn', color: '#4a72cc', icon: '🌙' },
];

const BUILT_IN_ORIGIN_ALIASES: readonly string[] = [
  'https://www.kimi.com',
];

export const BUILT_IN_ORIGINS: readonly string[] = Object.freeze([
  ...new Set([
    ...BUILT_IN_LINKS.map(link => new URL(link.url).origin),
    ...BUILT_IN_ORIGIN_ALIASES,
  ]),
]);
