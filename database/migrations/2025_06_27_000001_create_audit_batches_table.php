<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('audit_batches', function (Blueprint $table) {
            $table->id();

            /**
             * Optional pointer to Laravel’s own job_batches table (uuid string).
             * Leave nullable so you can also create a batch via CLI without using Bus::batch.
             */
            $table->uuid('job_batch_id')->nullable()->unique();

            // ---------- progress tracking ----------
            $table->unsignedInteger('total_jobs')->default(0);
            $table->unsignedInteger('processed_jobs')->default(0);
            $table->unsignedInteger('failed_jobs')->default(0);
            $table->json('failed_job_ids')->nullable();

            // ---------- status & timestamps ----------
            $table->string('status')->default('pending');   // pending | running | finished | failed
            $table->timestamp('started_at')->nullable();
            $table->timestamp('finished_at')->nullable();

            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('audit_batches');
    }
};
