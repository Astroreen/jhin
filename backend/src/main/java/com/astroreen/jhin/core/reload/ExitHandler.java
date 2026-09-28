package com.astroreen.jhin.core.reload;

/**
 * Шов завершения процесса для graceful reload: прод-реализация — {@code System.exit(code)},
 * в тестах подменяется фейком ({@code System.exit} в тестах запрещён).
 */
@FunctionalInterface
public interface ExitHandler {

    void exit(int code);
}
