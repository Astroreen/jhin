package com.astroreen.jhin.it;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Минимальный SSE-читатель поверх {@link HttpClient} (реальный HTTP-сервер, не MockMvc).
 * Фрейм события: {@code id: seq} / {@code event: type} / {@code data: JSON} + пустая строка;
 * комментарии (heartbeat {@code : keepalive}) игнорируются. EOF (сервер закрыл поток —
 * revoke/cap) — {@link #awaitEof}; {@link #close()} — обрыв соединения с клиента.
 */
final class SseTestClient {

    record Frame(long seq, String type, String data) {}

    private final HttpResponse<InputStream> response;
    private final BlockingQueue<Frame> frames = new LinkedBlockingQueue<>();
    private final CountDownLatch eof = new CountDownLatch(1);

    private SseTestClient(HttpResponse<InputStream> response) {
        this.response = response;
        Thread reader = new Thread(this::readLoop, "sse-test-reader");
        reader.setDaemon(true);
        reader.start();
    }

    /** Открывает GET /sessions/{id}/events?fromSeq=N c Bearer-токеном; 200 — обязателен. */
    static SseTestClient open(String baseUrl, String bearerToken, String sessionId, long fromSeq) {
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        HttpRequest request = HttpRequest.newBuilder(
                        URI.create(baseUrl + "/sessions/" + sessionId + "/events?fromSeq=" + fromSeq))
                .header("Authorization", "Bearer " + bearerToken)
                .header("Accept", "text/event-stream")
                .timeout(Duration.ofMinutes(2))
                .build();
        try {
            HttpResponse<InputStream> response =
                    client.send(request, HttpResponse.BodyHandlers.ofInputStream());
            if (response.statusCode() != 200) {
                throw new AssertionError("SSE open failed: HTTP " + response.statusCode());
            }
            return new SseTestClient(response);
        } catch (IOException e) {
            throw new AssertionError("SSE connect failed", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError("SSE connect interrupted", e);
        }
    }

    /** Следующий фрейм или null по таймауту. */
    Frame pollFrame(long timeoutMillis) {
        try {
            return frames.poll(timeoutMillis, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError("interrupted while waiting for SSE frame", e);
        }
    }

    /** true — поток завершён (EOF) в пределах timeoutMillis. */
    boolean awaitEof(long timeoutMillis) {
        try {
            return eof.await(timeoutMillis, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError("interrupted while waiting for SSE EOF", e);
        }
    }

    /** Обрыв соединения с клиента (сценарии реконнекта). */
    void close() {
        try {
            response.body().close();
        } catch (IOException ignored) {
            // best-effort: цель close() — оборвать соединение, ошибка чтения допустима
        }
    }

    private void readLoop() {
        try (BufferedReader in =
                new BufferedReader(new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
            Long id = null;
            String type = null;
            String data = null;
            String line;
            while ((line = in.readLine()) != null) {
                if (line.isEmpty()) {
                    if (id != null && type != null && data != null) {
                        frames.add(new Frame(id, type, data));
                    }
                    id = null;
                    type = null;
                    data = null;
                } else if (line.startsWith("id: ")) {
                    id = Long.parseLong(line.substring(4));
                } else if (line.startsWith("event: ")) {
                    type = line.substring(7);
                } else if (line.startsWith("data: ")) {
                    data = line.substring(6);
                }
            }
        } catch (IOException | RuntimeException ignored) {
            // падение чтения = конец потока
        } finally {
            eof.countDown();
        }
    }
}
