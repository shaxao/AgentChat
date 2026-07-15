package com.aiplatform.backend;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

@SpringBootApplication
@MapperScan("com.aiplatform.backend.mapper")
@EnableAsync
@EnableScheduling
public class BackendApplication {
    public static void main(String[] args) {
        SpringApplication.run(BackendApplication.class, args);
    }

    /**
     * 自定义 TaskScheduler — 设置线程池大小为 5
     * <p>
     * Spring Boot 默认的 ThreadPoolTaskScheduler 线程池大小为 1，
     * 如果某个工作流执行耗时较长，会阻塞其他定时任务的触发。
     * 设置为 5 确保多个工作流可以并行执行。
     */
    @Bean
    public ThreadPoolTaskScheduler taskScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(5);
        scheduler.setThreadNamePrefix("workflow-scheduler-");
        scheduler.setWaitForTasksToCompleteOnShutdown(true);
        scheduler.setAwaitTerminationSeconds(30);
        return scheduler;
    }


    //第一次启动启动运行
//    @Bean
//    public CommandLineRunner run(BCryptPasswordEncoder encoder) {
//        return args -> {
//            String password = "Admin@123456";
//            String hash = encoder.encode(password);
//            System.out.println("\n========================================");
//            System.out.println("密码: " + password);
//            System.out.println("BCrypt Hash: " + hash);
//            System.out.println("========================================\n");
//            System.out.println("请将上面生成的 hash 复制到 data.sql 中替换原有密码值。");
//        };
//    }
}
