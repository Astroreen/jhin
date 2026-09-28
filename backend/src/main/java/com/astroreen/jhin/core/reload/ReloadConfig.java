package com.astroreen.jhin.core.reload;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Дефолтный {@link ExitHandler}: завершает процесс через {@code System.exit(code)}.
 *
 * <p>В тестах подменяется {@code @Primary}-бином с фейковым exit — тестовый JVM никогда
 * не должен умирать.
 */
@Configuration
public class ReloadConfig {

    @Bean
    public ExitHandler processExitHandler() {
        return code -> System.exit(code);
    }
}
