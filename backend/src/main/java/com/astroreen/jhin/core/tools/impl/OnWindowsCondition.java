package com.astroreen.jhin.core.tools.impl;

import org.springframework.context.annotation.Condition;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.core.type.AnnotatedTypeMetadata;

/**
 * Условие Spring для Windows-only бинов: совпадает, только если {@code os.name}
 * содержит {@code "windows"} (без учёта регистра). От context/metadata не зависит.
 */
public class OnWindowsCondition implements Condition {

    @Override
    public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
        return isWindows();
    }

    static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("windows");
    }
}
