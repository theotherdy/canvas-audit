<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Page extends Model
{
    protected $fillable = [
        'course_id', 'module', 'title', 'html', 'plain',
    ];

    public function course(): BelongsTo
    {
        return $this->belongsTo(Course::class);
    }
}
