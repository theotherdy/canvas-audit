<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('audit_course_results', function (Blueprint $table) {
            $table->id();

            // Link back to the batch that produced this result
            $table->foreignId('batch_id')
                  ->nullable()                       // keep nullable so CLI audits work without batches
                  ->constrained('audit_batches')
                  ->cascadeOnDelete();

            // Canvas course identifier
            $table->unsignedBigInteger('course_id');

            // ---------- raw counts ----------
            $table->unsignedInteger('published_pages')->default(0);
            $table->unsignedInteger('classic_quizzes')->default(0);
            $table->unsignedInteger('new_quizzes')->default(0);
            $table->unsignedInteger('other_assignments')->default(0);
            $table->unsignedInteger('discussions')->default(0);
            $table->unsignedInteger('active_students')->default(0);

            // ---------- engagement ratios (0‑1) ----------
            $table->decimal('quiz_engagement',        5, 4)->default(0);   // e.g. 0.8750
            $table->decimal('assignment_engagement',  5, 4)->default(0);
            $table->decimal('discussion_engagement',  5, 4)->default(0);

            $table->timestamps();

            // combination must be unique so one row per course per batch
            $table->unique(['batch_id', 'course_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('audit_course_results');
    }
};
