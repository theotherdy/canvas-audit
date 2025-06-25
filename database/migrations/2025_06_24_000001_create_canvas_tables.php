
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('courses', function (Blueprint $t) {
            $t->id(); 
            $t->unsignedBigInteger('canvas_id')->unique();
            $t->string('name'); 
            $t->unsignedInteger('students')->default(0);
            $t->timestamps();
        });

        Schema::create('pages', function (Blueprint $t) {
            $t->id(); $t->foreignId('course_id')->constrained()->cascadeOnDelete();
            $t->string('module'); $t->string('title');
            $t->longText('html'); $t->longText('plain');
            $t->timestamps();
        });

        Schema::create('quizzes', function (Blueprint $t) {
            $t->id(); $t->foreignId('course_id')->constrained()->cascadeOnDelete();
            $t->string('title'); $t->string('type'); // classic | new_lti
            $t->string('lti_url')->nullable();
            $t->timestamps();
        });

        Schema::create('quiz_items', function (Blueprint $t) {
            $t->id(); $t->foreignId('quiz_id')->constrained()->cascadeOnDelete();
            $t->longText('question');
            $t->timestamps();
        });
    }
    public function down(): void
    {
        Schema::dropIfExists('quiz_items');
        Schema::dropIfExists('quizzes');
        Schema::dropIfExists('pages');
        Schema::dropIfExists('courses');
    }
};
