import asyncio
import time

HOST = "127.0.0.1"
PORT = 8080
CONCURRENT_WORKERS = 100  # Number of simultaneous async tasks

# Pre-formatted HTTP/1.1 GET request payload
HTTP_PAYLOAD = (
    f"GET / HTTP/1.1\r\n"
    f"Host: {HOST}:{PORT}\r\n"
    f"User-Agent: AsyncLoadTester/1.0\r\n"
    f"Connection: close\r\n\r\n"
).encode("utf-8")

total_requests = 0
start_time = time.time()

async def worker():
    global total_requests
    while True:
        try:
            # Non-blocking TCP connection directly over event loop
            reader, writer = await asyncio.open_connection(HOST, PORT)
            writer.write(HTTP_PAYLOAD)
            await writer.drain()
            
            # Read back response header
            await reader.read(256)
            
            writer.close()
            await writer.wait_closed()
            total_requests += 1
        except Exception:
            # Brief pause if port-forward connection buffer is full
            await asyncio.sleep(0.01)

async def monitor():
    while True:
        await asyncio.sleep(1)
        elapsed = time.time() - start_time
        rps = total_requests / elapsed if elapsed > 0 else 0
        print(f"\r🚀 Total Sent: {total_requests} | Throughput: {rps:.1f} req/sec | Active Coroutines: {CONCURRENT_WORKERS}", end="")

async def main():
    print(f"🔥 Starting Non-Blocking Async Stress Test on http://{HOST}:{PORT}")
    print(f"⚡ Concurrent Coroutines: {CONCURRENT_WORKERS}\n")
    
    tasks = [asyncio.create_task(worker()) for _ in range(CONCURRENT_WORKERS)]
    tasks.append(asyncio.create_task(monitor()))
    await asyncio.gather(*tasks)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n🛑 Async load test terminated.")