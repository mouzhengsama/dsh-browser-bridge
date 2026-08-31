export interface BuiltInLink {
  id: string;
  name: string;
  url: string;
  color: string;
}

export const BUILT_IN_LINKS: readonly BuiltInLink[] = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com', color: '#2f8f79' },
  { id: 'arena', name: 'Arena', url: 'https://arena.ai/agent', color: '#536fc4' },
  { id: 'workbuddy', name: 'WorkBuddy', url: 'https://workbuddy.cn/app', color: '#2ba986' },
  { id: 'trae', name: 'Trae', url: 'https://work.trae.cn', color: '#477ec3' },
  { id: 'qwen', name: 'Qwen', url: 'https://qwenwork.cn/app/chat', color: '#725eb7' },
  { id: 'manus', name: 'Manus', url: 'https://manus.im/app', color: '#555b64' },
  { id: 'shunova', name: 'Shunova', url: 'https://shunova.cc', color: '#b36d38' },
  { id: 'doubao', name: '豆包', url: 'https://doubao.com/chat', color: '#3a91df' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com', color: '#3e5fd3' },
  { id: 'yiyan', name: '文心一言', url: 'https://yiyan.baidu.com', color: '#3481e3' },
  { id: 'yuanbao', name: '腾讯元宝', url: 'https://hunyuan.tencent.com/bot/chat', color: '#16a76d' },
  { id: 'kimi', name: 'Kimi', url: 'https://kimi.moonshot.cn', color: '#4a72cc' },
  { id: 'chatglm', name: '智谱清言', url: 'https://chatglm.cn', color: '#2876d2' },
  { id: 'tiangong', name: '天工 AI', url: 'https://tiangong.cn', color: '#de5b4b' },
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
