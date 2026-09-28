package com.astroreen.jhin.core.tools.impl;

import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

/**
 * Регистрация {@link PowerShellTool} — только на Windows.
 *
 * <p>Бин {@code powerShellTool} создаётся исключительно когда {@link OnWindowsCondition}
 * совпадает ({@code os.name} содержит "windows"). Иначе {@code @Bean}-метод не вызывается,
 * ToolDefinition-бинов нет — {@link BuiltinToolsProvider} не видит тул и в
 * {@link com.astroreen.jhin.core.tools.ToolRegistry} нет "powershell".
 */
@Configuration
public class PowerShellToolConfig {

    @Bean
    @Conditional(OnWindowsCondition.class)
    public ToolDefinition powerShellTool() {
        return new PowerShellTool();
    }
}
