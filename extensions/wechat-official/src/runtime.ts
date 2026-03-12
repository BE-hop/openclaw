import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/compat";

const { getRuntime: getWechatOfficialRuntime, setRuntime: setWechatOfficialRuntime } =
  createPluginRuntimeStore<PluginRuntime>(
    "WeChat Official runtime not initialized - plugin not registered",
  );

export { getWechatOfficialRuntime, setWechatOfficialRuntime };
