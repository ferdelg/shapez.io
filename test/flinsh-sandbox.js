/**
 * A plain-JS copy of Flinsh's web/src/lib/miniAppSandbox.ts (buildMiniAppDocument and the
 * injected bridge), so the harness confines the game exactly the way Flinsh does:
 * CSP <meta> first, then the theme <style>, then the bridge <script>, then the app's HTML.
 *
 * Keep in sync with Flinch/web/src/lib/miniAppSandbox.ts.
 */
(function () {
    const MINI_APP_SANDBOX = "allow-scripts";
    const MINI_APP_CSP = [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "media-src data: blob:",
        "font-src data:",
        "connect-src 'none'",
        "form-action 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
    ].join("; ");

    const STORE_SCOPES = ["user", "app", "office"];

    function storeScopes(permissions) {
        return STORE_SCOPES.filter(s => permissions.includes("store:" + s));
    }

    function bridgeSource(input, scopes) {
        return (
            `(function(){` +
            `var seq=0,waiting={};` +
            `window.addEventListener("message",function(e){` +
            `if(e.source!==parent)return;` +
            `var d=e.data;if(!d||d.__flinshReply==null)return;` +
            `var w=waiting[d.__flinshReply];if(!w)return;delete waiting[d.__flinshReply];` +
            `d.error?w.reject(new Error(d.error)):w.resolve(d.result);});` +
            `function call(scope,op,payload){return new Promise(function(res,rej){` +
            `var id=++seq;waiting[id]={resolve:res,reject:rej};` +
            `parent.postMessage({__flinsh:"store",id:id,scope:scope,op:op,payload:payload||{}},"*");` +
            `setTimeout(function(){if(waiting[id]){delete waiting[id];rej(new Error("timed out"))}},15000);` +
            `})}` +
            `function api(scope){return{` +
            `get:function(k){return call(scope,"get",{key:k})},` +
            `set:function(k,v){return call(scope,"set",{key:k,value:v})},` +
            `list:function(p){return call(scope,"list",{prefix:p||""})},` +
            `delete:function(k){return call(scope,"delete",{key:k})}` +
            `}}` +
            `var store=api("user");` +
            (scopes.includes("app") ? `store.app=api("app");` : "") +
            (scopes.includes("office") ? `store.office=api("office");` : "") +
            `window.flinsh={input:${JSON.stringify(input)},` +
            `ready:function(){parent.postMessage({__flinsh:"ready"},"*")},` +
            `done:function(r){parent.postMessage({__flinsh:"done",result:r},"*")},` +
            `resize:function(h){parent.postMessage({__flinsh:"resize",height:h},"*")},` +
            `store:store,memory:api("user"),` +
            `log:function(label,status,detail){parent.postMessage(` +
            `{__flinsh:"worklog",event:{kind:"step",id:label,label:label,status:status||"done",detail:detail||""}},"*")}` +
            `};` +
            `window.dispatchEvent(new Event("flinsh:ready"));` +
            `})();`
        );
    }

    /**
     * Like buildMiniAppDocument. `bridgeDelayMs` > 0 injects the bridge late (harness-only),
     * to exercise the app's boot guard. `probe` adds a harness-only error/CSP reporter.
     */
    function buildMiniAppDocument({ html, themeCss, input, permissions = [], bridgeDelayMs = 0, probe = "" }) {
        let bridge = bridgeSource(input, storeScopes(permissions));
        if (bridgeDelayMs > 0) {
            bridge = `setTimeout(function(){${bridge}},${bridgeDelayMs});`;
        }
        return (
            `<meta http-equiv="Content-Security-Policy" content="${MINI_APP_CSP}">` +
            `<style>${themeCss}</style>` +
            (probe ? `<script>${probe}<\/script>` : "") +
            `<script>${bridge}<\/script>` +
            html
        );
    }

    window.FlinshSandbox = { MINI_APP_SANDBOX, MINI_APP_CSP, bridgeSource, buildMiniAppDocument, storeScopes };
})();
