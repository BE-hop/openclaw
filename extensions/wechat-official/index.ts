import type { OpenClawPluginApi } from "openclaw/plugin-sdk/compat";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/compat";
import { wechatOfficialPlugin } from "./src/channel.js";
import { setWechatOfficialRuntime } from "./src/runtime.js";

const plugin = {
  id: "wechat-official",
  name: "WeChat Official",
  description: "WeChat Official Account (公众号) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWechatOfficialRuntime(api.runtime);
    api.registerChannel({ plugin: wechatOfficialPlugin });
  },
};

export default plugin;
