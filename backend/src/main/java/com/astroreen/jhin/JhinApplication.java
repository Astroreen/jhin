package com.astroreen.jhin;

import com.astroreen.jhin.admin.AdminMain;
import java.util.Arrays;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class JhinApplication {

    public static void main(String[] args) {
        if (args.length > 0 && "admin".equals(args[0])) {
            AdminMain.main(Arrays.copyOfRange(args, 1, args.length));
            return;
        }
        SpringApplication.run(JhinApplication.class, args);
    }
}
