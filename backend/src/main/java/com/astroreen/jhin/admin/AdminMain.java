package com.astroreen.jhin.admin;

import com.astroreen.jhin.JhinApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Точка входа admin-режима: {@code java -jar jhin-backend.jar admin <command> ...}.
 *
 * <p>{@link JhinApplication#main} диспатчит сюда, если первый CLI-аргумент — {@code admin},
 * передавая оставшиеся аргументы. Бутит Spring с {@link WebApplicationType#NONE} (без Tomcat
 * и web) поверх того же DataSource и миграций, что и web ({@code jhin.home} из env
 * {@code JHIN_HOME} / свойства {@code jhin.home}, дефолты общие с application.yml),
 * исполняет {@link AdminCli} и завершает процесс его exit-кодом.
 */
public final class AdminMain {

    private AdminMain() {}

    public static void main(String[] args) {
        ConfigurableApplicationContext context = new SpringApplicationBuilder(JhinApplication.class)
                .web(WebApplicationType.NONE)
                .run(args);
        int code;
        try {
            code = context.getBean(AdminCli.class).run(args);
        } finally {
            context.close();
        }
        System.exit(code);
    }
}
