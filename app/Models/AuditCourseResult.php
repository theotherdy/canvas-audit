<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class AuditCourseResult extends Model
{
    use HasFactory;

    protected $fillable = [
        'batch_id',
        'course_id',
        'published_pages',
        'classic_quizzes',
        'new_quizzes',
        'other_assignments',
        'discussions',
        'active_students',
        'quiz_engagement',
        'assignment_engagement',
        'discussion_engagement',
    ];

    protected $casts = [
        'published_pages'       => 'integer',
        'classic_quizzes'       => 'integer',
        'new_quizzes'           => 'integer',
        'other_assignments'     => 'integer',
        'discussions'           => 'integer',
        'active_students'       => 'integer',
        'quiz_engagement'       => 'float',
        'assignment_engagement' => 'float',
        'discussion_engagement' => 'float',
    ];

    /* ─────────────── Relationships ─────────────── */

    public function batch()
    {
        return $this->belongsTo(AuditBatch::class);
    }
}
