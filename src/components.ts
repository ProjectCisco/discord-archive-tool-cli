// Discord's newer message layout ("components v2") keeps a message's text and images in
// components, leaving content and embeds empty. Only the parts that hold content are read;
// buttons and menus are skipped. The full components stay in the channel's .json file.
// Type numbers: https://docs.discord.com/developers/components/reference
const SECTION = 9;
const TEXT_DISPLAY = 10;
const THUMBNAIL = 11;
const MEDIA_GALLERY = 12;
const CONTAINER = 17;

export interface Media {
  url: string;
  proxy_url?: string;
}

export interface ComponentContent {
  text: string[];
  // Images not uploaded with the message. Uploaded ones carry an attachment_id and are saved
  // with the message's attachments.
  media: Media[];
}

export function componentContent(message: object): ComponentContent {
  const content: ComponentContent = { text: [], media: [] };

  const addMedia = (value: unknown) => {
    if (!isObject(value) || typeof value['url'] !== 'string' || value['attachment_id'] !== undefined) return;
    const proxy = value['proxy_url'];
    content.media.push(typeof proxy === 'string' ? { url: value['url'], proxy_url: proxy } : { url: value['url'] });
  };

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isObject(value)) return;
    const type = value['type'];
    if (type === TEXT_DISPLAY && typeof value['content'] === 'string') content.text.push(value['content']);
    else if (type === THUMBNAIL) addMedia(value['media']);
    else if (type === MEDIA_GALLERY && Array.isArray(value['items'])) {
      for (const item of value['items']) addMedia(isObject(item) ? item['media'] : undefined);
    } else if (type === SECTION || type === CONTAINER) {
      visit(value['components']);
      visit(value['accessory']);
    }
  };

  visit('components' in message ? message.components : undefined);
  return content;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
