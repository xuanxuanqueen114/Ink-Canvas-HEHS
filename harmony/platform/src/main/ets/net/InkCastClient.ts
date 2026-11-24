// InkCast：局域网墨迹同步客户端（NDJSON over TCP）
// 平板把提交后的笔画、清屏与 AI 批注推送到 PC 端的 InkCast 演示服务，
// 由大屏页面实时渲染。演示服务默认监听 9091（TCP）与 9090（大屏 HTTP）。
import { socket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';

export interface InkCastEvent {
  t: string;
}

export class InkCastClient {
  private tcp: socket.TCPSocket | null = null;
  private connected: boolean = false;
  private host: string = '127.0.0.1';
  private port: number = 9091;
  private pending: string[] = [];
  // 断线自动重连 + 心跳：服务重启或 Wi-Fi 抖动时保持"走动授课零掉线"。
  private reconnectTimer: number = -1;
  private heartbeatTimer: number = -1;
  private retryDelay: number = 1000;
  private manualClose: boolean = false;

  get Connected(): boolean {
    return this.connected;
  }

  connect(host: string, port: number): void {
    this.manualClose = false;
    this.host = host;
    this.port = port;
    this.retryDelay = 1000;
    this.doConnect();
  }

  private doConnect(): void {
    this.closeSocket();
    const tcp = socket.constructTCPSocketInstance();
    this.tcp = tcp;
    tcp.on('connect', () => {
      this.connected = true;
      this.retryDelay = 1000;
      this.flush();
      this.startHeartbeat();
    });
    tcp.on('close', () => {
      this.handleDisconnect();
    });
    tcp.on('error', (err: BusinessError) => {
      void err;
      this.handleDisconnect();
    });
    tcp.on('message', (value: socket.TCPReceiveInfo) => {
      void value;
    });
    tcp.connect({
      address: { address: this.host, port: this.port },
      timeout: 5000
    }, (err: BusinessError) => {
      if (err) {
        this.handleDisconnect();
      }
    });
  }

  private handleDisconnect(): void {
    this.connected = false;
    this.stopHeartbeat();
    if (this.manualClose || this.reconnectTimer >= 0) {
      return;
    }
    const delay = Math.min(15000, this.retryDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = -1;
      this.retryDelay = Math.min(15000, this.retryDelay * 2);
      this.doConnect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.connected) {
        this.send({ t: 'q' });
      }
    }, 5000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer >= 0) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = -1;
    }
  }

  private closeSocket(): void {
    if (this.tcp !== null) {
      try {
        this.tcp.close();
      } catch (error) {
        void error;
      }
    }
    this.tcp = null;
    this.connected = false;
  }

  send(event: Object): void {
    const line = JSON.stringify(event) + '\n';
    if (!this.connected || this.tcp === null) {
      this.pending.push(line);
      if (this.pending.length > 500) {
        this.pending.shift();
      }
      return;
    }
    this.tcp.send({ data: line }, (err: BusinessError) => {
      if (err) {
        this.connected = false;
      }
    });
  }

  sendStroke(id: string, colorArgb: number, width: number, highlighter: boolean,
    alpha: number, taper: number, shape: boolean, points: number[][]): void {
    this.send({
      t: 'stroke',
      id: id,
      color: colorArgb,
      width: width,
      highlighter: highlighter,
      alpha: alpha,
      taper: taper,
      shape: shape,
      points: points
    });
  }

  sendClear(): void {
    this.send({ t: 'clear' });
  }

  sendAi(title: string, text: string, tags: string[]): void {
    this.send({ t: 'ai', title: title, text: text, tags: tags });
  }

  private flush(): void {
    if (this.tcp === null) {
      return;
    }
    const lines = this.pending;
    this.pending = [];
    for (let i = 0; i < lines.length; i++) {
      this.tcp.send({ data: lines[i] }, (err: BusinessError) => {
        void err;
      });
    }
  }

  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer >= 0) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = -1;
    }
    this.stopHeartbeat();
    this.closeSocket();
    this.pending = [];
  }
}