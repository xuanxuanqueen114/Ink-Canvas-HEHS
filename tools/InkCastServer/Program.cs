// InkCast Windows 端接收服务（无第三方依赖）：
//   平板 --TCP 9091 (NDJSON)--> 本服务 --HTTP/SSE 9090--> 讲台大屏浏览器
// 用法：dotnet run --project tools/InkCastServer
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

internal static class Program
{
    private const int TcpPort = 9091;
    private const int HttpPort = 9090;
    private static readonly ConcurrentDictionary<int, StreamWriter> TcpClients = new();
    private static readonly ConcurrentDictionary<int, Stream> SseClients = new();
    private static readonly ConcurrentQueue<string> History = new();
    private static int _strokeCount;

    private static async Task Main()
    {
        Console.WriteLine($"[InkCast] TCP {TcpPort}, Screen http://<PC-IP>:{HttpPort}/");
        _ = Task.Run(AcceptTcpAsync);
        _ = Task.Run(AcceptHttpAsync);
        await Task.Delay(Timeout.Infinite);
    }

    private static async Task AcceptTcpAsync()
    {
        var listener = new TcpListener(IPAddress.Any, TcpPort);
        listener.Start();
        while (true)
        {
            var client = await listener.AcceptTcpClientAsync();
            _ = HandleTcpAsync(client);
        }
    }

    private static async Task HandleTcpAsync(TcpClient client)
    {
        var id = client.GetHashCode();
        using var stream = client.GetStream();
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
        TcpClients[id] = writer;
        try
        {
            string line;
            while ((line = await reader.ReadLineAsync()) != null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                if (line.Contains("\"t\":\"q\"")) continue;
                await BroadcastAsync(line.Trim());
            }
        }
        catch
        {
            // client gone
        }
        finally
        {
            TcpClients.TryRemove(id, out _);
        }
    }

    private static async Task BroadcastAsync(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var t = doc.RootElement.TryGetProperty("t", out var tv) ? tv.GetString() : "";
            if (t == "stroke")
            {
                Interlocked.Increment(ref _strokeCount);
                var pts = doc.RootElement.TryGetProperty("points", out var pv) ? pv.GetArrayLength() : 0;
                Console.WriteLine($"[stroke] points={pts} total={_strokeCount}");
            }
            else if (t == "ai")
            {
                var title = doc.RootElement.TryGetProperty("title", out var v) ? v.GetString() : "";
                Console.WriteLine($"[ai] {title}");
            }
            else if (t == "clear")
            {
                Console.WriteLine("[clear]");
            }
        }
        catch (JsonException)
        {
            Console.WriteLine("[bad-json] " + json[..Math.Min(120, json.Length)]);
            return;
        }

        var payload = "data: " + json + "\n\n";
        History.Enqueue(payload);
        while (History.Count > 5000) History.TryDequeue(out _);

        foreach (var pair in SseClients)
        {
            try
            {
                var bytes = Encoding.UTF8.GetBytes(payload);
                await pair.Value.WriteAsync(bytes);
                await pair.Value.FlushAsync();
            }
            catch
            {
                SseClients.TryRemove(pair.Key, out _);
            }
        }
    }

    private static async Task AcceptHttpAsync()
    {
        var listener = new TcpListener(IPAddress.Any, HttpPort);
        listener.Start();
        while (true)
        {
            var client = await listener.AcceptTcpClientAsync();
            _ = HandleHttpAsync(client);
        }
    }

    private static async Task HandleHttpAsync(TcpClient client)
    {
        var stream = client.GetStream();
        try
        {
            using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
            var requestLine = await reader.ReadLineAsync();
            if (requestLine == null) return;
            while (!string.IsNullOrEmpty(await reader.ReadLineAsync())) { }

            var path = requestLine.Split(' ').Length > 1 ? requestLine.Split(' ')[1] : "/";
            if (path.StartsWith("/events"))
            {
                var header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\n: connected\n\n";
                await stream.WriteAsync(Encoding.UTF8.GetBytes(header));
                foreach (var item in History) await stream.WriteAsync(Encoding.UTF8.GetBytes(item));
                await stream.FlushAsync();
                SseClients[client.GetHashCode()] = stream;
                // 保持连接：不关闭 stream/client
                return;
            }

            string body;
            string contentType = "text/plain; charset=utf-8";
            if (path == "/" || path.StartsWith("/index"))
            {
                body = ScreenPage;
                contentType = "text/html; charset=utf-8";
            }
            else if (path.StartsWith("/health"))
            {
                body = $"{{\"ok\":true,\"strokes\":{_strokeCount},\"sse\":{SseClients.Count}}}";
                contentType = "application/json";
            }
            else
            {
                body = "not found";
            }

            var bytes = Encoding.UTF8.GetBytes(body);
            var resp = $"HTTP/1.1 200 OK\r\nContent-Type: {contentType}\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n";
            await stream.WriteAsync(Encoding.UTF8.GetBytes(resp));
            await stream.WriteAsync(bytes);
            await stream.FlushAsync();
        }
        catch
        {
            // ignore
        }
        finally
        {
            if (!SseClients.Values.Contains(stream))
            {
                stream.Dispose();
                client.Dispose();
            }
        }
    }

    private const string ScreenPage = """
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>InkCast 大屏 · 实时板书</title>
<style>
html,body{margin:0;height:100%;background:#fafafa;font-family:HarmonyOS Sans,Segoe UI,sans-serif;overflow:hidden}
#bar{height:44px;display:flex;align-items:center;gap:16px;padding:0 16px;background:#151519;color:#fff;font-size:13px}
#dot{width:10px;height:10px;border-radius:5px;background:#e74c3c}
#dot.ok{background:#22c55e}
#ai{position:fixed;right:20px;bottom:20px;width:360px;max-height:70vh;overflow:auto;display:flex;flex-direction:column;gap:10px}
.card{background:#1e1e24;color:#fff;border-radius:14px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);border-left:4px solid #38e1ff}
.card h4{margin:0 0 6px;font-size:14px}.card p{margin:0;font-size:12px;line-height:1.6;color:#d7d7e0}
canvas{display:block;width:100vw;height:calc(100vh - 44px)}
</style></head><body>
<div id="bar"><span id="dot"></span><span id="state">等待平板连接…</span><span id="stats"></span></div>
<canvas id="cv"></canvas><div id="ai"></div>
<script>
const cv=document.getElementById("cv"),ctx=cv.getContext("2d");
function resize(){cv.width=innerWidth;cv.height=innerHeight-44;draw();}
addEventListener("resize",resize);
const strokes=new Map();
function color(v){const a=(v>>>24)&255,r=(v>>>16)&255,g=(v>>>8)&255,b=v&255;return "rgba("+r+","+g+","+b+","+(a/255)+")";}
function drawStroke(s){if(!s.points||!s.points.length)return;ctx.beginPath();ctx.strokeStyle=s.color;s.lineWidth=Math.max(.5,s.width||2);
if(s.highlighter){ctx.globalAlpha=(s.alpha||96)/255;ctx.lineCap="butt";}else{ctx.globalAlpha=1;ctx.lineCap="round";}
for(let i=0;i<s.points.length;i++){const p=s.points[i];if(i===0)ctx.moveTo(p[0],p[1]);else ctx.lineTo(p[0],p[1]);}ctx.stroke();ctx.globalAlpha=1;}
function draw(){ctx.clearRect(0,0,cv.width,cv.height);for(const s of strokes.values())drawStroke(s);}
const es=new EventSource("/events");
es.onopen=()=>{document.getElementById("dot").classList.add("ok");document.getElementById("state").textContent="平板已连接";};
es.onerror=()=>{document.getElementById("dot").classList.remove("ok");document.getElementById("state").textContent="连接中断，重试中…";};
es.onmessage=(m)=>{let ev;try{ev=JSON.parse(m.data)}catch(e){return}
if(ev.t==="stroke"){ev.color=color(ev.color||0xFF000000);strokes.set(ev.id||Math.random(),ev);draw();
document.getElementById("stats").textContent="笔画 "+strokes.size;}
else if(ev.t==="clear"){strokes.clear();draw();}
else if(ev.t==="ai"){const box=document.getElementById("ai");const d=document.createElement("div");d.className="card";
d.innerHTML="<h4>"+(ev.title||"AI 批注")+"</h4><p>"+(ev.text||"")+"</p>";box.prepend(d);}};
resize();
</script></body></html>
""";
}