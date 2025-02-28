const DOMAIN_URL = "https://grok.com";
const ASSETS_URL = "https://assets.grok.com";

// 用 Map 存储账户信息，key 是账户 ID
const memoryAccounts = new Map<string, { id: string; cookie: string }>();

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  console.log('Request URL:', req.url);

  // 添加新的路由处理同步请求
  if (url.pathname === '/api/sync') {
    if (req.method === 'POST') {
      const body = await req.json();
      const localAccounts = body.accounts || [];
      
      // 合并本地和内存中的账户
      const mergedAccounts = new Map();
      
      // 先添加内存中的账户
      for (const [id, account] of memoryAccounts) {
        mergedAccounts.set(id, account);
      }
      
      // 合并本地账户
      for (const account of localAccounts) {
        if (account.id && account.cookie) {
          mergedAccounts.set(account.id, account);
        }
      }
      
      // 更新内存存储
      memoryAccounts.clear();
      for (const [id, account] of mergedAccounts) {
        memoryAccounts.set(id, account);
      }
      
      // 返回合并后的账户列表
      return new Response(JSON.stringify({
        accounts: Array.from(mergedAccounts.values())
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Method not allowed', { status: 405 });
  }

  // 添加保存账户的路由
  if (url.pathname === '/api/account') {
    if (req.method === 'POST') {
      const body = await req.json();
      if (body.id && body.cookie) {
        memoryAccounts.set(body.id, {
          id: body.id,
          cookie: body.cookie
        });
        return new Response(JSON.stringify({ success: true }));
      }
      return new Response('Invalid account data', { status: 400 });
    }
    return new Response('Method not allowed', { status: 405 });
  }

  // 处理主页面
  const filePath = url.pathname;
  console.log('filePath:', filePath);
  if (filePath === '/' || filePath === '/index.html') {
      const fullPath = `${Deno.cwd()}/src/static/index.html`;
      const file = await Deno.readFile(fullPath);
      return new Response(file, {
        headers: {
          'content-type': `text/html;charset=UTF-8`,
        },
      });
  }
  
  let targetPath;
  let domainUrl = DOMAIN_URL;
  // 如果是 /grok 路径，移除前缀
  if (url.pathname.startsWith('/grok')) {
    targetPath = url.pathname.replace(/^\/grok/, '');
   // 如果是 /assets 路径，移除前缀，重定到资源站
  } else if (url.pathname.startsWith('/assets')) {
    targetPath = url.pathname.replace(/^\/assets/, '');
    domainUrl = ASSETS_URL
  } else {
    // 其他 直接使用路径（可能是Grok内部请求）
    targetPath = url.pathname;
  }
  
  const targetFullUrl = new URL(targetPath + url.search, domainUrl);
  console.log('Target URL:', targetFullUrl.toString());

  // 构造代理请求
  const headers = new Headers(req.headers);
  headers.set("Host", targetFullUrl.host);


  // 从请求的cookie中读取grok_cookie
  let grokCookie = '';
  const cookieHeader = req.headers.get('cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
      const [name, value] = cookie.trim().split('=');
      if (name === 'grok_cookie') {
        grokCookie = decodeURIComponent(value);
        break;
      }
    }
  }

  //实际用这个cookie请求grok
  headers.set("cookie", grokCookie || '');
  headers.delete("Referer");

  try {
    const fetchResponse = await fetch(targetFullUrl.toString(), {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    });

    const responseHeaders = new Headers(fetchResponse.headers);
    responseHeaders.delete("Content-Length");

    // 替换请求中的部分资源地址
    const textTransformStream = new TransformStream({
      transform: (chunk, controller) => {
        const contentType = responseHeaders.get("Content-Type") || "";
        if (contentType.startsWith("text/") || contentType.includes("json")) {
          let decodedText = new TextDecoder("utf-8").decode(chunk);

          // 替换assets.grok.com链接，让图片请求本地走代理
          if (contentType.includes("text/html")) {
            const serverOrigin = new URL(req.url).origin;
            decodedText = decodedText.replaceAll(ASSETS_URL, serverOrigin);
          }
          
          // 替换users/为assets/users/，适配本地图片地址
          if (contentType.includes("json") && 
              (decodedText.includes("streamingImageGenerationResponse") || 
              decodedText.includes("generatedImageUrls"))) {
                decodedText = decodedText.replaceAll('users/', 'assets/users/');
          }
          
          controller.enqueue(new TextEncoder().encode(decodedText));
        } else {
          controller.enqueue(chunk);
        }
      }
    });

    const transformedStream = fetchResponse.body?.pipeThrough(textTransformStream);

    return new Response(transformedStream, {
      status: fetchResponse.status,
      headers: responseHeaders,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Proxy Error:', errorMessage);
    return new Response(`Proxy Error: ${errorMessage}`, { status: 500 });
  }
};

Deno.serve(handleRequest); 