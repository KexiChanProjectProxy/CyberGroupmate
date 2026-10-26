<script>
  export let config;
  export let pwFocus;
  export let pwBlur;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-magnifying-glass opacity-50 mr-1"></i> Web 搜索 / 抓取
</h3>
<p class="text-xs opacity-50 mb-3">
  Agent 可调用的 <code>web.search()</code> / <code>web.fetch()</code>（子 agent 与 Meta 均可用），在宿主侧执行，沙盒无网络时也能用。
</p>

<div class="cfg-grid-2">
  <label class="cfg-field col-span-2">
    <span class="cfg-label">HTTP(S) 代理 <span class="opacity-40">(可选，search 与 fetch 共用)</span></span>
    <input
      type="text"
      class="input input-xs input-bordered w-full"
      bind:value={config.web.proxy}
      placeholder="http://127.0.0.1:7890"
    />
  </label>
</div>

<h4 class="text-xs font-semibold mt-4 mb-2 opacity-70">联网搜索（OpenAI Responses + web_search）</h4>
<div class="cfg-grid-2">
  <label class="cfg-field">
    <span class="cfg-label">API Key</span>
    <input
      type="password"
      class="input input-xs input-bordered w-full"
      bind:value={config.web.search.apiKey}
      placeholder="留空则 web.search 不可用"
      on:focus={pwFocus}
      on:blur={pwBlur}
    />
  </label>
  <label class="cfg-field">
    <span class="cfg-label">模型 <span class="opacity-40">(可选)</span></span>
    <input
      type="text"
      class="input input-xs input-bordered w-full"
      bind:value={config.web.search.model}
      placeholder="gpt-6-luna"
    />
  </label>
  <label class="cfg-field">
    <span class="cfg-label">Base URL <span class="opacity-40">(可选)</span></span>
    <input
      type="text"
      class="input input-xs input-bordered w-full"
      bind:value={config.web.search.baseUrl}
      placeholder="https://api.openai.com/v1"
    />
  </label>
  <label class="cfg-field">
    <span class="cfg-label">超时 (ms) <span class="opacity-40">(可选)</span></span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.web.search.timeoutMs}
      placeholder="60000"
    />
  </label>
</div>

<h4 class="text-xs font-semibold mt-4 mb-2 opacity-70">网页抓取</h4>
<div class="cfg-grid-2">
  <label class="cfg-field">
    <span class="cfg-label">超时 (ms)</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.web.fetch.timeoutMs}
      placeholder="15000"
    />
  </label>
  <label class="cfg-field">
    <span class="cfg-label">正文最大字符数</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.web.fetch.maxChars}
      placeholder="20000"
    />
  </label>
  <label class="cfg-field col-span-2">
    <span class="cfg-label">User-Agent <span class="opacity-40">(可选)</span></span>
    <input
      type="text"
      class="input input-xs input-bordered w-full"
      bind:value={config.web.fetch.userAgent}
      placeholder="默认使用桌面 Chrome UA"
    />
  </label>
</div>

<div class="mt-3 p-2 rounded bg-base-200 text-xs opacity-60">
  <i class="fa-solid fa-circle-info mr-1"></i>
  web.fetch 只允许公网 http/https 地址，拒绝 localhost / 私网 / 云元数据地址。代理只支持 http:// 或 https://，不支持 socks。
</div>
