<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Course extends Model
{
    protected $fillable = [
        'canvas_id',   // Canvas numerical ID
        'name',        // Course title
        'students',    // Active-student count
    ];

    /* ---- Relationships ---- */
    //public function pages()  : HasMany { return $this->hasMany(Page::class);  }
    //public function quizzes(): HasMany { return $this->hasMany(Quiz::class); }
}
