<script>
  export let config;
  export let pwFocus;
  export let pwBlur;

  $: if (config.dashboard && !config.dashboard.cloudflareAccess) {
    config.dashboard.cloudflareAccess = { teamDomain: "", aud: "", allowedEmails: [] };
  }
  $: cfaEmails = (config.dashboard?.cloudflareAccess?.allowedEmails ?? []).join(", ");
  function setCfaEmails(e) {
    config.dashboard.cloudflareAccess.allowedEmails = e.currentTarget.value
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-gauge-high opacity-50 mr-1"></i> Dashboard
  <span class="restart-hint"
    ><i class="fa-solid fa-rotate-right"></i> 修改需重启</span
  >
</h3>
<p class="text-xs opacity-50 mb-3">
  监听地址、端口与访问 token。默认仅本机；公网请谨慎并务必设置强 token。
</p>
<div class="cfg-grid-3">
  <label class="cfg-check"
    ><input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.dashboard.enabled}
    /><span>启用</span></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">主机名 / IP</span>
    <input
      type="text"
      class="input input-xs input-bordered w-full"
      bind:value={config.dashboard.host}
      placeholder="127.0.0.1"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">端口</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      bind:value={config.dashboard.port}
      placeholder="6767"
    /></label
  >
</div>
<label class="cfg-field mt-2"
  ><span class="cfg-label">Token</span>
  <input
    type="password"
    class="input input-xs input-bordered w-full"
    bind:value={config.dashboard.token}
    on:focus={pwFocus}
    on:blur={pwBlur}
  /></label
>

<h4 class="text-xs font-semibold mt-4 mb-1">Cloudflare Access</h4>
<p class="text-xs opacity-50 mb-2">
  经 Cloudflare Tunnel 发布并由 Access 保护时填写：携带有效 Access JWT 的请求无需 token。留空则不启用。
</p>
<div class="cfg-grid-3">
  <label class="cfg-field"
    ><span class="cfg-label">Team 域名</span>
    <input
      type="text"
      class="input input-xs input-bordered w-full"
      bind:value={config.dashboard.cloudflareAccess.teamDomain}
      placeholder="yourteam.cloudflareaccess.com"
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">Application AUD</span>
    <input
      type="text"
      class="input input-xs input-bordered w-full"
      bind:value={config.dashboard.cloudflareAccess.aud}
    /></label
  >
  <label class="cfg-field"
    ><span class="cfg-label">允许的邮箱（逗号分隔，可选）</span>
    <input
      type="text"
      class="input input-xs input-bordered w-full"
      value={cfaEmails}
      on:change={setCfaEmails}
    /></label
  >
</div>
